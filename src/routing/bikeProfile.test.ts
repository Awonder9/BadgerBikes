import { describe, expect, it } from 'vitest'
import { BIKE_ROUTING } from '../config'
import { destination } from '../lib/geo'
import type { UpstreamFetch, UpstreamRequest } from '../lib/upstream'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import meta from '../test/fixtures/trip_meta.json'
import type { LngLat } from '../types'
import { createRouter } from './index'
import { sameRoute } from './sameRoute'
import { routeBody } from './valhalla'
import type { RouteRequest } from './types'

const pick = [meta.pickup_candidates[0]![3] as number, meta.pickup_candidates[0]![2] as number] as LngLat
const drop = [meta.dropoff_candidates[0]![3] as number, meta.dropoff_candidates[0]![2] as number] as LngLat
const req: RouteRequest = { role: 'ride', mode: 'bike', from: pick, to: drop, units: 'metric', language: 'en-US' }
const useRoadsOf = (url: string) => (JSON.parse(decodeURIComponent(url.split('json=')[1]!)) as { costing_options: { bicycle: { use_roads: number } } }).costing_options.bicycle.use_roads

describe('bike route options', () => {
  it('sends use_roads to Valhalla (bike-friendly default)', () => {
    const body = (u?: number) => (routeBody({ ...req, ...(u === undefined ? {} : { useRoads: u }) }) as { costing_options: { bicycle: { use_roads: number } } }).costing_options.bicycle.use_roads
    expect(body()).toBe(BIKE_ROUTING.defaultUseRoads)
    expect(body(0.8)).toBe(0.8)
  })

  it('returns one route per level, in order (none is swapped for the quickest)', async () => {
    const seen: number[] = []
    const up = (async (r: UpstreamRequest) => {
      const u = useRoadsOf(r.url)
      seen.push(u)
      // Level 0 gives one path; the higher levels a different (shifted) one that is slower.
      if (u < 0.25) return valhallaBike
      return {
        trip: {
          units: 'kilometers',
          legs: [
            {
              shape: shiftedShape(),
              summary: { length: 2.5, time: 99999 },
              maneuvers: [
                { type: 1, instruction: 'Head north.', length: 2.5, time: 99999, begin_shape_index: 0, end_shape_index: 2 },
                { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2, end_shape_index: 2 },
              ],
            },
          ],
        },
      }
    }) as UpstreamFetch
    const levels = BIKE_ROUTING.options.map((o) => o.useRoads)
    const routes = await createRouter({ upstream: up }).routeLadder(req, levels)
    expect(seen).toEqual(levels)
    expect(routes.map((r) => r.useRoads)).toEqual(levels)
    // Each option keeps its own route, even when another level's is quicker.
    expect(routes.map((r) => r.duration)).toEqual(levels.map((u) => (u < 0.25 ? routes.find((x) => x.useRoads === 0)!.duration : 99999)))
  })

  it('detects same and different paths', () => {
    const a: LngLat[] = [pick, destination(pick, 500, 90), destination(pick, 1000, 90)]
    const b: LngLat[] = [pick, destination(pick, 1000, 90)]
    const c: LngLat[] = [pick, destination(destination(pick, 500, 90), 300, 0), destination(pick, 1000, 90)]
    expect(sameRoute(a, b, 60)).toBe(true)
    expect(sameRoute(a, c, 60)).toBe(false)
  })
})

/** A different path for the "road-happy" level: the fixture shape detoured 400 m north. */
function shiftedShape(): string {
  // Encode [start, north detour, end] at precision 6.
  const pts: LngLat[] = [pick, destination(destination(pick, 400, 0), 600, 270), drop]
  let out = ''
  let pl = 0
  let pn = 0
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63)
      x >>= 5
    }
    out += String.fromCharCode(x + 63)
  }
  for (const [lon, lat] of pts) {
    const la = Math.round(lat * 1e6)
    const lo = Math.round(lon * 1e6)
    enc(la - pl)
    enc(lo - pn)
    pl = la
    pn = lo
  }
  return out
}
