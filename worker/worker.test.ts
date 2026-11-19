import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP, NATIVE_APP } from '../src/config'
import { resetHttpState, setFetchImpl } from '../src/lib/http'
import type { PushRideRequest, StatsResponse, UsageRequest } from '../src/api/contract'
import { makeSnapshot, makeStation } from '../src/test/factories'
import { AppError } from '../src/lib/errors'
import { createApp, resetAnalyticsCache, type AppDeps, type RideAlertsRpc, type UsageRpc } from './app'
import { GateCore } from './gateCore'
import { createUpstream, resetUpstreamState, type Gate } from './upstream'

const snapshot = makeSnapshot([makeStation({ id: 's1' })])
const maneuver = {
  kind: 'left',
  instruction: 'Turn left onto the Southwest Commuter Path.',
  verbalPre: 'Turn left onto the Southwest Commuter Path.',
  verbalPost: 'Continue for 1 mile.',
  verbalAlert: 'Turn left onto the Southwest Commuter Path.',
  verbalSuccinct: 'Turn left.',
  verbalMultiCue: true,
  streetNames: ['Southwest Commuter Path'],
  distance: 1600,
  duration: 360,
  location: [-89.4, 43.07],
  beginIndex: 0,
  endIndex: 1,
}
const deps = (o: Partial<AppDeps> = {}): AppDeps => ({
  upstream: (async () => ({})) as never,
  createRouter: () => ({ route: async () => ({}) as never, routeLadder: async (_r: unknown, levels: readonly number[]) => levels.map((useRoads) => ({ provider: 'valhalla', useRoads, maneuvers: [maneuver] })) as never, routeDetails: async () => ({ breakdown: [{ kind: 'bikePath', meters: 100 }], elevation: null, segments: [] }) }),
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

  it('first visit: picks the nearest city and returns its stations in one request', async () => {
    const asked: string[] = []
    const app = createApp(deps({ fetchStationsSnapshot: async (id) => (asked.push(id), { ...snapshot, systemId: id }) }))
    const req = (cf?: Record<string, string>) => Object.assign(new Request('https://x.test/api/stations?system=nearest'), cf ? { cf } : {})
    const near = (await (await app.fetch(req({ latitude: '40.0150', longitude: '-105.2705' }))).json()) as { systemId: string; stations: unknown[] }
    expect([near.systemId, near.stations.length]).toEqual(['bcycle_boulder', 1])
    // Nowhere near a BCycle city, or no location: the default city.
    expect(((await (await app.fetch(req({ latitude: '61.2', longitude: '-149.9' }))).json()) as { systemId: string }).systemId).toBe(APP.defaultSystemId)
    expect(((await (await app.fetch(req())).json()) as { systemId: string }).systemId).toBe(APP.defaultSystemId)
    expect(asked).toEqual(['bcycle_boulder', APP.defaultSystemId, APP.defaultSystemId])
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
    const res = (await (await call(app, '/api/routes', { method: 'POST', body })).json()) as { routes: Array<{ useRoads: number; maneuvers: unknown[] }> }
    expect(res.routes.map((r) => r.useRoads)).toEqual([0, 0.35, 1])
    // Without the spoken-instruction text (unused by the app); what finds trail sections stays.
    const { verbalPre: _p, verbalPost: _o, verbalAlert: _a, verbalSuccinct: _s, verbalMultiCue: _m, ...kept } = maneuver
    expect(res.routes[0]?.maneuvers).toEqual([kept])
  })

  it('applies per-client rate limits', async () => {
    const app = createApp(deps({ limiters: { route: { limit: async () => ({ success: false }) } as unknown as RateLimit } }))
    const res = await call(app, '/api/routes', { method: 'POST', body: routeBody })
    expect(res.status).toBe(429)
  })
})

describe('the native apps (CORS)', () => {
  const from = (origin: string, path = '/api/stations?system=bcycle_madison', init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    call(createApp(deps()), path, { ...init, headers: { Origin: origin, ...init.headers } })
  const preflight = { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }

  it('answers the iOS and Android apps’ preflights and requests, errors included', async () => {
    expect(NATIVE_APP.origins).toEqual(['capacitor://localhost', 'https://localhost'])
    for (const origin of NATIVE_APP.origins) {
      const pre = await from(origin, '/api/routes', preflight)
      expect(pre.status).toBe(204)
      expect(Object.fromEntries(pre.headers)).toMatchObject({
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'Content-Type',
        vary: 'Origin',
      })
      const ok = await from(origin)
      expect([ok.status, ok.headers.get('Access-Control-Allow-Origin'), ok.headers.get('Vary')]).toEqual([200, origin, 'Origin'])
      const route = await from(origin, '/api/routes', { method: 'POST', body: routeBody })
      expect([route.status, route.headers.get('Access-Control-Allow-Origin')]).toEqual([200, origin])
      // The app reads error codes (e.g. "busy, try again") from cross-origin errors too.
      const bad = await from(origin, '/api/stations?system=../evil')
      expect([bad.status, bad.headers.get('Access-Control-Allow-Origin')]).toEqual([404, origin])
    }
  })

  it('gives every other origin no CORS headers and no preflight answer, as before', async () => {
    for (const origin of ['https://evil.example', 'http://localhost', 'capacitor://evil', 'null']) {
      const res = await from(origin)
      expect([res.status, res.headers.get('Access-Control-Allow-Origin'), res.headers.get('Vary')]).toEqual([200, null, null])
      const pre = await from(origin, '/api/routes', preflight)
      expect([pre.status, pre.headers.get('Access-Control-Allow-Origin')]).toEqual([404, null])
    }
    // Same-origin requests (the web app) carry no Origin on GET.
    expect((await call(createApp(deps()), '/api/stations?system=bcycle_madison')).headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('background ride alerts API', () => {
  const now = 1_800_000_000_000
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }
  const ride = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, lang: 'en', systemId: 'bcycle_madison', endStationId: 'bcycle_madison_1874', partySize: 1, rideStartedAtMs: now - 60_000, includedMinutes: 30, ...o })
  function withPush() {
    const calls: Array<{ endpoint: string; op: string; req?: PushRideRequest }> = []
    const rideAlerts = async (endpoint: string): Promise<RideAlertsRpc> => ({
      schedule: async (req) => void calls.push({ endpoint, op: 'schedule', req }),
      cancel: async () => void calls.push({ endpoint, op: 'cancel' }),
    })
    return { calls, app: createApp(deps({ now: () => now, push: { publicKey: 'BPUBLIC', rideAlerts } })) }
  }
  const post = (app: ReturnType<typeof createApp>, path: string, body: string) => call(app, path, { method: 'POST', body })

  it('is off (and says so) without VAPID keys; the public key is published in /api/meta when on', async () => {
    const off = createApp(deps())
    expect(await (await call(off, '/api/meta')).json()).toMatchObject({ pushPublicKey: null })
    expect((await post(off, '/api/push/ride', ride())).status).toBe(404)
    expect(await (await call(withPush().app, '/api/meta')).json()).toMatchObject({ pushPublicKey: 'BPUBLIC' })
  })

  it('schedules the device’s ride and cancels it, keyed by its endpoint', async () => {
    const { app, calls } = withPush()
    const res = await post(app, '/api/push/ride', ride())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', op: 'schedule', req: { lang: 'en', endStationId: 'bcycle_madison_1874', includedMinutes: 30 } })
    expect((await post(app, '/api/push/cancel', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }))).status).toBe(200)
    expect(calls[1]).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', op: 'cancel' })
  })

  it('only ever sends to known push services over https (never an arbitrary URL)', async () => {
    const { app, calls } = withPush()
    const refused = ['https://evil.example/fcm', 'http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'javascript:alert(1)']
    const statuses = await Promise.all(refused.map(async (endpoint) => [endpoint, (await post(app, '/api/push/ride', ride({ subscription: { endpoint, keys } }))).status]))
    expect(statuses).toEqual(refused.map((endpoint) => [endpoint, 400]))
    expect((await post(app, '/api/push/ride', ride({ subscription: { endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=x', keys } }))).status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('rejects malformed keys, languages, parties and implausible times', async () => {
    const { app, calls } = withPush()
    const bad = [
      ride({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'AAAA', auth: keys.auth } } }),
      ride({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: keys.p256dh, auth: '<b>' } } }),
      ride({ lang: 'fr' }),
      ride({ partySize: 9 }),
      ride({ rideStartedAtMs: now - 5 * 60 * 60_000 }),
      ride({ rideStartedAtMs: now + 10 * 60_000 }),
      ride({ includedMinutes: 0 }),
      ride({ endStationId: '../x' }),
      ride({ systemId: 'bcycle_nowhere' }),
    ]
    const statuses = await Promise.all(bad.map(async (body) => (await post(app, '/api/push/ride', body)).status))
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 404]) // the last: an unknown city
    expect(calls).toHaveLength(0)
    expect((await post(app, '/api/push/ride', ride({ rideStartedAtMs: null, includedMinutes: null, endStationId: null }))).status).toBe(200)
  })
})

describe('usage counts and the dashboard', () => {
  afterEach(() => resetAnalyticsCache())
  function usageDeps() {
    const recorded: UsageRequest[] = []
    const counted: string[] = []
    const usage: UsageRpc = {
      record: async (req) => void recorded.push(req),
      count: async (name) => void counted.push(name),
      report: async (days) => ({ timeZone: 'America/Chicago', generatedAtMs: 0, activeNow: 3, allTimeUsers: 9, since: null, days: Array.from({ length: days }, () => ({}) as never) }),
    }
    return { recorded, counted, usage }
  }
  const post = (body: unknown, ua = 'Mozilla/5.0 (iPhone)') => ({ method: 'POST', body: JSON.stringify(body), headers: { 'User-Agent': ua } })
  const first = { gap: 3, systemId: 'bcycle_madison', platform: 'android', installed: true, lang: 'zh-Hans' }

  it('counts known reports from people, not from bots, and refuses anything else', async () => {
    const { recorded, usage } = usageDeps()
    const app = createApp(deps({ usage }))
    expect((await call(app, '/api/usage', post({ kind: 'open', first }))).status).toBe(200)
    expect((await call(app, '/api/usage', post({ kind: 'beat', first: null }))).status).toBe(200)
    expect((await call(app, '/api/usage', post({ kind: 'event', name: 'gpx' }))).status).toBe(200)
    // A city this Worker doesn't know still counts the device, without the city.
    await call(app, '/api/usage', post({ kind: 'open', first: { ...first, gap: null, systemId: 'bcycle_atlantis' } }))
    expect((await call(app, '/api/usage', post({ kind: 'open', first: null }, 'Googlebot/2.1'))).status).toBe(200)
    expect(recorded).toEqual([
      { kind: 'open', first },
      { kind: 'beat', first: null },
      { kind: 'event', name: 'gpx' },
      { kind: 'open', first: { ...first, gap: null, systemId: null } },
    ])
    const bad = [
      { kind: 'event', name: 'routes' }, // counted by the Worker only
      { kind: 'visit' },
      { kind: 'open', first: { ...first, gap: 0 } },
      { kind: 'open', first: { ...first, gap: 91 } },
      { kind: 'open', first: { ...first, platform: 'windows' } },
      { kind: 'open', first: { ...first, lang: 'fr' } },
      { kind: 'open', first: { ...first, installed: 'yes' } },
      { kind: 'open', first: { systemId: 'bcycle_madison', platform: 'ios', installed: false, lang: 'en' } }, // no gap
    ]
    expect(await Promise.all(bad.map(async (b) => (await call(app, '/api/usage', post(b))).status))).toEqual(bad.map(() => 400))
    expect(recorded).toHaveLength(4)
  })

  it('the dashboard numbers are public, checked, and read from the Usage object at most every 30 s', async () => {
    const { usage } = usageDeps()
    let reads = 0
    let now = 1_800_000_000_000
    const app = createApp(deps({ now: () => now, usage: { ...usage, report: (days) => (reads++, usage.report(days)) } }))
    const ok = await call(app, '/api/analytics?days=30')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Cache-Control')).toBe('no-store')
    expect(((await ok.json()) as StatsResponse).days).toHaveLength(30)
    await call(app, '/api/analytics?days=30')
    expect(reads).toBe(1)
    now += 30_000
    await call(app, '/api/analytics?days=30')
    expect(reads).toBe(2)
    expect((await call(app, '/api/analytics?days=0')).status).toBe(400)
    expect((await call(createApp(deps()), '/api/analytics')).status).toBe(404) // a server without usage counts
  })

  it('counts route requests, and the ones the busy routing server turned away', async () => {
    const { counted, usage } = usageDeps()
    const pending: Array<Promise<unknown>> = []
    const ok = createApp(deps({ usage, background: (w) => void pending.push(w) }))
    await call(ok, '/api/routes', { method: 'POST', body: routeBody })
    const busyRouter = () => ({ ...deps().createRouter({ upstream: deps().upstream }), routeLadder: async () => Promise.reject(new AppError('upstream_unavailable', 'busy')) })
    const busy = createApp(deps({ usage, background: (w) => void pending.push(w), createRouter: busyRouter as never }))
    expect((await call(busy, '/api/routes', { method: 'POST', body: routeBody })).status).toBe(503)
    await Promise.all(pending)
    expect(counted).toEqual(['routes', 'routes_busy'])
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
