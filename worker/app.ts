// HTTP layer for /api/*. Dependencies are injected so handlers are testable in Node.
import { APP, BIKE_ROUTING } from '../src/config'
import {
  API_PATHS,
  NEAREST_SYSTEM,
  type LocateResponse,
  type MetaResponse,
  type OkResponse,
  type PushRideRequest,
  type StationsResponse,
  type StatsResponse,
  type UsageCounter,
  type UsageRequest,
} from '../src/api/contract'
import { nearestSystem } from '../src/data/systems'
import { isValidLngLat } from '../src/lib/geo'
import type { fetchStationsSnapshot as FetchStations, fetchSystemDetails as FetchSystem } from '../src/data/gbfs'
import { searchBias, type reversePlace as Reverse, type searchPlaces as Search } from '../src/geocode/photon'
import { AppError, toAppError, type AppErrorCode } from '../src/lib/errors'

import type { UpstreamFetch } from '../src/lib/upstream'
import type { AltRouter } from '../src/routing/types'
import type { RouteLeg } from '../src/types'
import { geocodeQuery, latLonParams, pushCancelRequest, pushRideRequest, readJsonBody, reportDays, requireSystem, routeDetailsRequest, routeRequest, usageRequest } from './validate'

/** One device's background ride alerts (the RideAlerts Durable Object's RPC methods). */
export interface RideAlertsRpc {
  schedule(req: PushRideRequest): Promise<void>
  cancel(): Promise<void>
}

/** The anonymous usage counts (the Usage Durable Object's RPC methods). */
export interface UsageRpc {
  record(req: UsageRequest): Promise<void>
  count(name: UsageCounter): Promise<void>
  report(days: number): Promise<StatsResponse>
}

export interface AppDeps {
  upstream: UpstreamFetch
  createRouter: (deps: { upstream: UpstreamFetch }) => AltRouter
  fetchStationsSnapshot: typeof FetchStations
  fetchSystemDetails: typeof FetchSystem
  searchPlaces: typeof Search
  reversePlace: typeof Reverse
  now: () => number
  contactEmail: string | null
  version: string
  /** Per-client limits; undefined → unlimited. */
  limiters?: { route?: RateLimit; geocode?: RateLimit; push?: RateLimit; usage?: RateLimit }
  /** Background ride alerts (Web Push); null when this deployment has no VAPID keys. */
  push?: { publicKey: string; rideAlerts: (endpoint: string) => Promise<RideAlertsRpc> } | null
  /** Anonymous usage counts; null/undefined → not counted. */
  usage?: UsageRpc | null
  /** Keeps work the response doesn't wait for alive after it is sent (ctx.waitUntil). */
  background?: (work: Promise<unknown>) => void
}

/** Crawlers and automated browsers aren't people using the app. */
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed/i

/**
 * The dashboard's numbers, kept per Worker isolate for ANALYTICS_CACHE_MS: the page is public, so a shared link
 * must not turn into one Usage-object read per visit.
 */
const ANALYTICS_CACHE_MS = 30_000
const analyticsCache = new Map<number, { atMs: number; body: StatsResponse }>()

/** Test hook. */
export function resetAnalyticsCache(): void {
  analyticsCache.clear()
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

/**
 * A route option as the app gets it: without the spoken-instruction text Valhalla adds to every maneuver
 * (verbal*), which nothing has read since turn-by-turn moved to Google Maps. It was about half of each maneuver,
 * sent three times per plan and saved on the device with the plan.
 */
export function routeForApp(leg: RouteLeg): RouteLeg {
  return { ...leg, maneuvers: leg.maneuvers.map(({ verbalAlert: _a, verbalPre: _p, verbalPost: _o, verbalSuccinct: _s, verbalMultiCue: _m, ...m }) => m) }
}

/** The BCycle city nearest Cloudflare's city-level estimate of where a request came from (no browser permission). */
function systemNear(request: Request) {
  const cf = (request as Request & { cf?: { latitude?: unknown; longitude?: unknown } }).cf
  const coord = [Number(cf?.longitude), Number(cf?.latitude)]
  return isValidLngLat(coord) ? nearestSystem(coord) : null
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } })
}

const STATUS: Partial<Record<AppErrorCode, number>> = {
  bad_request: 400,
  unknown_system: 404,
  not_found: 404,
  location_unroutable: 422,
  no_route: 422,
  rate_limited: 429,
  upstream_unavailable: 503,
  aborted: 499,
  timeout: 504,
  network: 502,
  http: 502,
  bad_response: 502,
}

const errorBody = (e: AppError) => ({ error: { code: e.code, message: e.code === 'internal' ? 'Something went wrong' : e.message, retryable: e.retryable } })

export function errorResponse(err: unknown): Response {
  const e = toAppError(err)
  return json(errorBody(e), STATUS[e.code] ?? 500)
}

async function limit(limiter: RateLimit | undefined, request: Request): Promise<void> {
  if (!limiter) return
  const key = request.headers.get('CF-Connecting-IP') ?? 'local'
  try {
    const { success } = await limiter.limit({ key })
    if (!success) throw new AppError('rate_limited', 'Too many requests; slow down a little.')
  } catch (e) {
    if (e instanceof AppError) throw e
  }
}

export function createApp(deps: AppDeps) {
  /** Counts something in the background; never delays or fails the response. */
  function count(name: UsageCounter): void {
    if (!deps.usage) return
    const work = deps.usage.count(name).catch(() => {})
    deps.background?.(work)
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const p = url.pathname
    const method = request.method
    const signal = request.signal

    if (p === API_PATHS.health) return json({ ok: true, service: 'badger-bikes', time: new Date(deps.now()).toISOString() })
    if (p === API_PATHS.meta) return json({ contactEmail: deps.contactEmail, version: deps.version, pushPublicKey: deps.push?.publicKey ?? null } satisfies MetaResponse)

    if ((p === API_PATHS.pushRide || p === API_PATHS.pushCancel) && method === 'POST') {
      await limit(deps.limiters?.push, request)
      if (!deps.push) throw new AppError('not_found', 'Background alerts are not set up on this server')
      const body = await readJsonBody(request)
      if (p === API_PATHS.pushRide) {
        const ride = pushRideRequest(body, deps.now())
        await (await deps.push.rideAlerts(ride.subscription.endpoint)).schedule(ride)
      } else {
        await (await deps.push.rideAlerts(pushCancelRequest(body).endpoint)).cancel()
      }
      return json({ ok: true } satisfies OkResponse)
    }

    if (p === API_PATHS.locate && method === 'GET') return json({ systemId: systemNear(request)?.id ?? null } satisfies LocateResponse)

    if (p === API_PATHS.stations && method === 'GET') {
      const requested = url.searchParams.get('system')
      // First visit: pick the city here, in the same round trip as its stations.
      const sys = requested === NEAREST_SYSTEM ? (systemNear(request) ?? requireSystem(APP.defaultSystemId)) : requireSystem(requested)
      const s = await deps.fetchStationsSnapshot(sys.id, deps.upstream, { signal, now: deps.now })
      const body: StationsResponse = { systemId: s.systemId, lastUpdatedMs: s.lastUpdatedMs, fetchedAtMs: s.fetchedAtMs, stations: [...s.stations] }
      return json(body)
    }

    if (p === API_PATHS.system && method === 'GET') {
      const sys = requireSystem(url.searchParams.get('system'))
      return json(await deps.fetchSystemDetails(sys.id, deps.upstream, { signal }))
    }

    if (p === API_PATHS.geocode && method === 'GET') {
      await limit(deps.limiters?.geocode, request)
      const sys = requireSystem(url.searchParams.get('system'))
      const q = geocodeQuery(url.searchParams.get('q'))
      const near = url.searchParams.has('lat') ? latLonParams(url.searchParams) : null
      return json({ places: await deps.searchPlaces(q, searchBias(sys, near), deps.upstream, { signal }) })
    }

    if (p === API_PATHS.reverse && method === 'GET') {
      await limit(deps.limiters?.geocode, request)
      return json({ place: await deps.reversePlace(latLonParams(url.searchParams), deps.upstream, { signal }) })
    }

    if (p === API_PATHS.routeDetails && method === 'POST') {
      await limit(deps.limiters?.route, request)
      const { polyline } = routeDetailsRequest(await readJsonBody(request))
      const router = deps.createRouter({ upstream: deps.upstream })
      return json(await router.routeDetails(polyline, { signal, priority: 'background' }))
    }

    if (p === API_PATHS.routes && method === 'POST') {
      await limit(deps.limiters?.route, request)
      const body = await readJsonBody(request)
      const r = routeRequest(body)
      const { systemId: _s, priority, ...routeReq } = r
      const router = deps.createRouter({ upstream: deps.upstream })
      try {
        const routes = await router.routeLadder(routeReq, BIKE_ROUTING.options.map((o) => o.useRoads), { signal, priority: priority ?? 'interactive' })
        count('routes')
        return json({ routes: routes.map(routeForApp) })
      } catch (err) {
        const code = toAppError(err).code
        if (code === 'upstream_unavailable' || code === 'rate_limited') count('routes_busy') // the rider was asked to try again
        throw err
      }
    }

    if (p === API_PATHS.usage && method === 'POST') {
      await limit(deps.limiters?.usage, request)
      const report = usageRequest(await readJsonBody(request))
      if (deps.usage && !BOT_UA.test(request.headers.get('User-Agent') ?? 'bot')) await deps.usage.record(report)
      return json({ ok: true } satisfies OkResponse)
    }

    if (p === API_PATHS.analytics && method === 'GET') {
      if (!deps.usage) throw new AppError('not_found', 'Usage counts are not set up on this server')
      await limit(deps.limiters?.usage, request)
      const days = reportDays(url.searchParams.get('days'))
      const cached = analyticsCache.get(days)
      if (cached && deps.now() - cached.atMs < ANALYTICS_CACHE_MS) return json(cached.body)
      const body = await deps.usage.report(days)
      analyticsCache.set(days, { atMs: deps.now(), body })
      return json(body)
    }

    if (p.startsWith('/api/')) throw new AppError('not_found', `No API route for ${method} ${p}`)
    return new Response(null, { status: 404 })
  }

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request)
      } catch (err) {
        return errorResponse(err)
      }
    },
  }
}
