import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetHttpState, setFetchImpl } from '../src/lib/http'
import { makeSnapshot, makeStation } from '../src/test/factories'
import { createApp, type AppDeps } from './app'
import { GateCore } from './gateCore'
import { createUpstream, resetUpstreamState, type Gate } from './upstream'

const snapshot = makeSnapshot([makeStation({ id: 's1' })])
const deps = (o: Partial<AppDeps> = {}): AppDeps => ({
  upstream: (async () => ({})) as never,
  createRouter: () => ({ route: async () => ({}) as never, routeLadder: async (_r: unknown, levels: readonly number[]) => levels.map((useRoads) => ({ provider: 'valhalla', useRoads })) as never, routeDetails: async () => ({ breakdown: [{ kind: 'bikePath', meters: 100 }], elevation: null, segments: [] }) }),
  fetchStationsSnapshot: async () => snapshot,
  fetchSystemDetails: async () => ({}) as never,
  searchPlaces: async () => [],
  reversePlace: async () => null,
  now: () => 1_800_000_000_000,
  contactEmail: null,
  version: 'test',
  ...o,
})
const call = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.fetch(new Request(`https://x.test${path}`, init))
const routeBody = JSON.stringify({ systemId: 'bcycle_madison', role: 'ride', mode: 'bike', from: [-89.38, 43.07], to: [-89.41, 43.07], units: 'imperial' })

describe('worker app', () => {
  it('serves stations and validates systems', async () => {
    const app = createApp(deps())
    const ok = await call(app, '/api/stations?system=bcycle_madison')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Cache-Control')).toBe('no-store')
    expect(((await ok.json()) as { stations: unknown[] }).stations).toHaveLength(1)
    const bad = await call(app, '/api/stations?system=../evil')
    expect(bad.status).toBe(404)
    expect(await bad.json()).toMatchObject({ error: { code: 'unknown_system' } })
    expect((await call(app, '/api/nope')).status).toBe(404)
  })

  it('suggests the city nearest the request location, or none', async () => {
    const app = createApp(deps())
    const req = (cf?: Record<string, string>) => Object.assign(new Request('https://x.test/api/locate'), cf ? { cf } : {})
    expect(await (await app.fetch(req({ latitude: '43.0731', longitude: '-89.4012' }))).json()).toEqual({ systemId: 'bcycle_madison' })
    expect(await (await app.fetch(req({ latitude: '61.2', longitude: '-149.9' }))).json()).toEqual({ systemId: null })
    expect(await (await app.fetch(req())).json()).toEqual({ systemId: null })
  })

  it('returns route details for a valid polyline only', async () => {
    const app = createApp(deps())
    const { encodePolyline } = await import('../src/lib/polyline')
    const polyline = encodePolyline([[-89.38, 43.07], [-89.39, 43.071]], 6)
    const ok = await call(app, '/api/route-details', { method: 'POST', body: JSON.stringify({ systemId: 'bcycle_madison', polyline }) })
    expect(await ok.json()).toEqual({ breakdown: [{ kind: 'bikePath', meters: 100 }], elevation: null, segments: [] })
    const bad = await call(app, '/api/route-details', { method: 'POST', body: JSON.stringify({ systemId: 'bcycle_madison', polyline: '<script>' }) })
    expect(bad.status).toBe(400)
  })

  it('rejects bad input', async () => {
    const app = createApp(deps())
    const bad = await call(app, '/api/routes', { method: 'POST', body: '{"systemId":"bcycle_madison","role":"ride"}' })
    expect(bad.status).toBe(400)
    const short = await call(app, '/api/geocode?system=bcycle_madison&q=a')
    expect(short.status).toBe(400)
    expect((await call(app, '/api/plan', { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('returns the three route options: bike-friendly, balanced, fastest', async () => {
    const app = createApp(deps())
    const body = JSON.stringify({ systemId: 'bcycle_madison', role: 'ride', mode: 'bike', from: [-89.38, 43.07], to: [-89.41, 43.07], units: 'imperial' })
    const res = (await (await call(app, '/api/routes', { method: 'POST', body })).json()) as { routes: Array<{ useRoads: number }> }
    expect(res.routes.map((r) => r.useRoads)).toEqual([0, 0.35, 1])
  })

  it('applies per-client rate limits', async () => {
    const app = createApp(deps({ limiters: { route: { limit: async () => ({ success: false }) } as unknown as RateLimit } }))
    const res = await call(app, '/api/routes', { method: 'POST', body: routeBody })
    expect(res.status).toBe(429)
  })
})

describe('gate core', () => {
  afterEach(() => vi.useRealTimers())
  it('spaces grants, prefers interactive, and opens the circuit on 429', async () => {
    vi.useFakeTimers()
    const core = new GateCore({ minSpacingMs: 1000, maxInFlight: 5, circuitOpenMs: 60_000, queueDeadlineMs: { interactive: 10_000, background: 15_000 }, holdTimeoutMs: 30_000, errorThreshold: 3 })
    const order: string[] = []
    const a = core.acquire('background').then((g) => { order.push('b1'); return g })
    const b = core.acquire('background').then(() => order.push('b2'))
    const c = core.acquire('interactive').then(() => order.push('i'))
    await vi.advanceTimersByTimeAsync(2500)
    await Promise.all([a, b, c])
    expect(order).toEqual(['b1', 'i', 'b2'])
    const g = await a
    if (g.ok) core.release(g.ticket, 'rate_limited')
    expect(await core.acquire('interactive')).toMatchObject({ ok: false, reason: 'circuit_open' })
  })
})

describe('upstream layer', () => {
  afterEach(() => { resetHttpState(); resetUpstreamState() })
  it('caches, sends the User-Agent, and maps denials', async () => {
    let calls = 0
    let ua = ''
    const restore = setFetchImpl(async (_u, init) => {
      calls++
      const h = init?.headers as Record<string, string> | undefined
      ua = h?.['User-Agent'] ?? ''
      return new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } })
    })
    const up = createUpstream({ gateFor: () => null, contactEmail: 'ops@example.test' })
    const req = { url: 'https://u.test/x', group: 'fossgis' as const, priority: 'interactive' as const, provider: 'valhalla', cacheKey: 'k', cacheTtlMs: 60_000 }
    expect(await up(req)).toEqual({ a: 1 })
    expect(await up(req)).toEqual({ a: 1 })
    expect(calls).toBe(1)
    expect(ua).toContain('badger-bikes')
    expect(ua).toContain('ops@example.test')
    const denied: Gate = { acquire: async () => ({ ok: false, reason: 'circuit_open', retryAfterMs: 1000 }), release: async () => {} }
    const up2 = createUpstream({ gateFor: () => denied })
    await expect(up2({ ...req, cacheKey: 'other' })).rejects.toMatchObject({ code: 'upstream_unavailable' })
    restore()
  })

  it('answers without waiting for the Cache API write, and keeps gate releases alive past the response', async () => {
    const restore = setFetchImpl(async () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }))
    let finishPut = () => {}
    const cache = { match: async () => undefined, put: () => new Promise<void>((r) => (finishPut = r)) } as unknown as Cache
    const released: string[] = []
    const gate: Gate = { acquire: async () => ({ ok: true, ticket: 't1' }), release: async (ticket, outcome) => void released.push(`${ticket}:${outcome}`) }
    const background: Array<Promise<unknown>> = []
    const up = createUpstream({ gateFor: () => gate, cache, waitUntil: (work) => void background.push(work) })
    const req = { url: 'https://u.test/y', group: 'fossgis' as const, priority: 'interactive' as const, provider: 'valhalla', cacheKey: 'k2', cacheTtlMs: 60_000 }
    expect(await up(req)).toEqual({ a: 1 }) // resolved while the Cache API write is still pending
    expect(background).toHaveLength(2) // the release and the cache write
    expect(await up(req)).toEqual({ a: 1 }) // served from the in-isolate copy meanwhile
    finishPut()
    await Promise.all(background)
    expect(released).toEqual(['t1:ok'])
    restore()
  })
})
