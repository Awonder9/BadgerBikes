import { describe, expect, it } from 'vitest'
import { AppError } from '../lib/errors'
import type { UpstreamFetch, UpstreamRequest } from '../lib/upstream'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import valhallaWalk from '../test/fixtures/valhalla/route_pedestrian.json'
import valhallaFar from '../test/fixtures/valhalla/route_far_from_road.json'
import osrmBike from '../test/fixtures/osrm/route_bike.json'
import osrmFoot from '../test/fixtures/osrm/route_foot.json'
import meta from '../test/fixtures/trip_meta.json'
import type { LngLat } from '../types'
import { createRouter } from './index'
import { osrmKind, valhallaKind } from './maneuvers'
import { assertLegInvariants } from './normalize'
import { normalizeOsrmRoute } from './osrm'
import type { RouteRequest } from './types'
import { normalizeValhallaRoute } from './valhalla'

const ll = (latlon: number[]): LngLat => [latlon[1]!, latlon[0]!]
const origin = ll(meta.origin)
const pick = meta.pickup_candidates.map((c) => [c[3] as number, c[2] as number] as LngLat)
const drop = meta.dropoff_candidates.map((c) => [c[3] as number, c[2] as number] as LngLat)

const req = (o: Partial<RouteRequest>): RouteRequest => ({ role: 'ride', mode: 'bike', from: pick[0]!, to: drop[0]!, units: 'metric', language: 'en-US', ...o })

describe('valhalla normalization', () => {
  it('produces valid legs from real fixtures', () => {
    const bike = normalizeValhallaRoute(valhallaBike, req({ stationId: 's' }))
    assertLegInvariants(bike)
    expect(bike.distance).toBeGreaterThan(1000)
    expect(bike.maneuvers.at(-1)!.kind).toBe('arrive')
    expect(bike.stationId).toBe('s')
    const walk = normalizeValhallaRoute(valhallaWalk, req({ role: 'toPickup', mode: 'walk', from: origin, to: pick[0]! }))
    assertLegInvariants(walk)
    expect(walk.maneuvers.some((m) => m.verbalPre)).toBe(true)
  })

  it('adds connectors when the router snapped far away', () => {
    const lake: LngLat = [-89.42, 43.1]
    const leg = normalizeValhallaRoute(valhallaFar, req({ mode: 'walk', from: lake, to: [-89.3842, 43.0747] }))
    assertLegInvariants(leg)
    expect(leg.snapFromM).toBeGreaterThan(100)
    expect(leg.geometry[0]).toEqual(lake)
  })

  it('maps maneuver kinds', () => {
    expect(valhallaKind(15)).toBe('left')
    expect(valhallaKind(24)).toBe('keep-left')
    expect(valhallaKind(40)).toBe('steps')
    expect(osrmKind('fork', 'slight left')).toBe('keep-left')
    expect(osrmKind('turn', 'sharp right')).toBe('sharp-right')
    expect(osrmKind('roundabout', undefined)).toBe('roundabout')
  })
})

describe('osrm normalization', () => {
  it('stitches steps into valid legs with generated text', () => {
    for (const [fx, mode] of [[osrmBike, 'bike'], [osrmFoot, 'walk']] as const) {
      const leg = normalizeOsrmRoute(fx, req({ mode }))
      assertLegInvariants(leg)
      expect(leg.maneuvers.every((m) => m.instruction.length > 0)).toBe(true)
    }
  })
  it('treats code != Ok as an error', () => {
    expect(() => normalizeOsrmRoute({ code: 'NoRoute' }, req({}))).toThrow(AppError)
  })
})

describe('router facade', () => {
  const fakeUpstream = (handler: (r: UpstreamRequest) => unknown): UpstreamFetch =>
    (async (r: UpstreamRequest) => handler(r)) as UpstreamFetch

  it('falls back Valhalla → OSRM → straight', async () => {
    const calls: string[] = []
    const r1 = createRouter({
      upstream: fakeUpstream((r) => {
        calls.push(r.provider)
        if (r.provider === 'valhalla') throw new AppError('rate_limited', '429')
        return osrmBike
      }),
    })
    expect((await r1.route(req({}))).provider).toBe('osrm')
    expect(calls).toEqual(['valhalla', 'osrm'])
    const r2 = createRouter({ upstream: fakeUpstream(() => { throw new AppError('network', 'down') }) })
    const leg = await r2.route(req({}))
    expect(leg.provider).toBe('straight')
    assertLegInvariants(leg)
  })

  it('asks the rider to retry instead of returning straight-line route options when routing is busy', async () => {
    const calls: string[] = []
    const r = createRouter({ upstream: fakeUpstream((u) => { calls.push(u.provider); throw new AppError('upstream_unavailable', 'busy') }) })
    await expect(r.routeLadder(req({}), [0, 0.35, 1])).rejects.toMatchObject({ code: 'upstream_unavailable', retryable: true })
    expect(calls).toEqual(['valhalla', 'osrm']) // stops after the first option
  })

  it('says when there is no bike route at all (both routers found none) instead of asking to retry', async () => {
    const valhallaNone = () => {
      throw new AppError('http', '400', { status: 400, body: { error_code: 442 } })
    }
    const none = createRouter({ upstream: fakeUpstream((u) => (u.provider === 'valhalla' ? valhallaNone() : { code: 'NoRoute' })) })
    await expect(none.routeLadder(req({}), [0, 0.35, 1])).rejects.toMatchObject({ code: 'no_route' })
    // Only one of them found none and the other was busy: a retry may well work.
    const busy = createRouter({
      upstream: fakeUpstream((u) => {
        if (u.provider === 'valhalla') return valhallaNone()
        throw new AppError('upstream_unavailable', 'busy')
      }),
    })
    await expect(busy.routeLadder(req({}), [0, 0.35, 1])).rejects.toMatchObject({ code: 'upstream_unavailable', retryable: true })
    // A single leg (walking, say) still gets the straight-line estimate.
    expect((await none.route(req({ mode: 'walk' }))).provider).toBe('straight')
  })

  it('surfaces location_unroutable for user points and never falls back after abort', async () => {
    const r = createRouter({ upstream: fakeUpstream(() => { throw new AppError('http', '400', { status: 400, body: { error_code: 171 } }) }) })
    await expect(r.route(req({ toIsUserPoint: true }))).rejects.toMatchObject({ code: 'location_unroutable' })
    const c = new AbortController()
    c.abort()
    const r3 = createRouter({ upstream: fakeUpstream(() => { throw new AppError('aborted', 'x') }) })
    await expect(r3.route(req({}), { signal: c.signal })).rejects.toMatchObject({ code: 'aborted' })
  })

  it('includes units in cache keys', async () => {
    const keys: string[] = []
    const r = createRouter({ upstream: fakeUpstream((u) => { keys.push(u.cacheKey ?? ''); throw new AppError('timeout', 't') }) })
    await r.route(req({ units: 'imperial' })).catch(() => {})
    expect(keys.some((k) => k.includes('|imperial|'))).toBe(true)
  })
})
