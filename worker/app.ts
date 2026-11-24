// HTTP layer for /api/* (and the apps' /.well-known/* link files). Dependencies are injected so handlers are
// testable in Node.
import { APP, BIKE_ROUTING, LOOP, NATIVE_APP } from '../src/config'
import {
  API_PATHS,
  NEAREST_SYSTEM,
  type LocateResponse,
  type LoopResponse,
  type MetaResponse,
  type OkResponse,
  type PushRideRequest,
  type ReverseResponse,
  type RouteResponse,
  type WeatherResponse,
  type StationsResponse,
  type StatsResponse,
  type UsageCounter,
  type UsageRequest,
} from '../src/api/contract'
import { nearAnySystem, nearestSystem } from '../src/data/systems'
import { isValidLngLat } from '../src/lib/geo'
import type { fetchStationsSnapshot as FetchStations, fetchSystemDetails as FetchSystem } from '../src/data/gbfs'
import { searchBias, type reversePlace as Reverse, type searchPlaces as Search } from '../src/geocode/photon'
import { AppError, toAppError, type AppErrorCode } from '../src/lib/errors'

import type { UpstreamFetch } from '../src/lib/upstream'
import type { AltRouter } from '../src/routing/types'
import type { RouteLeg } from '../src/types'
import type { fetchWeather as FetchWeather } from '../src/weather/openMeteo'
import { appLinksResponse, type AppLinkIds } from './appLinks'
import { stravaRevokeRequest, stravaTokenRequest, stravaUploadRequest, stravaUploadStatusRequest } from './validate'
import { stravaRevoke, stravaToken, stravaUpload, stravaUploadStatus, type StravaApp } from './strava'
import { geocodeQuery, latLonParams, loopRequest, pushCancelRequest, pushRideRequest, readJsonBody, reportDays, requireSystem, routeDetailsRequest, routeRequest, usageRequest } from './validate'

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
  fetchWeather: typeof FetchWeather
  now: () => number
  contactEmail: string | null
  version: string
  /** Per-client limits; undefined → unlimited. */
  limiters?: { route?: RateLimit; geocode?: RateLimit; push?: RateLimit; usage?: RateLimit; strava?: RateLimit }
  /** "Send to Strava": the deployment's Strava app (client secret); null/undefined → the feature is off. */
  strava?: StravaApp | null
  /** Background ride alerts (Web Push); null when this deployment has no VAPID keys. */
  push?: { publicKey: string; rideAlerts: (endpoint: string) => Promise<RideAlertsRpc> } | null
  /** Anonymous usage counts; null/undefined → not counted. */
  usage?: UsageRpc | null
  /** Keeps work the response doesn't wait for alive after it is sent (ctx.waitUntil). */
  background?: (work: Promise<unknown>) => void
  /** The iOS/Android apps this site's share links may open (/.well-known/*); undefined → none. */
  appLinks?: AppLinkIds
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
 * CORS for the native apps only (NATIVE_APP.origins): their page is served from the phone, so every /api/*
 * request they make is cross-origin. Other origins get no CORS headers, as before (the web app is same-origin).
 */
function corsHeaders(origin: string | null): Record<string, string> | null {
  return origin !== null && (NATIVE_APP.origins as readonly string[]).includes(origin) ? { 'Access-Control-Allow-Origin': origin } : null
}

/** A preflight answer (the client's POSTs carry a JSON body): what src/lib/http.ts sends. */
const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': String(NATIVE_APP.preflightMaxAgeSeconds),
  Vary: 'Origin',
}

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
  unauthorized: 401,
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

    if (p.startsWith('/.well-known/')) return (method === 'GET' && appLinksResponse(p, deps.appLinks)) || new Response(null, { status: 404 })
    if (p === API_PATHS.health) return json({ ok: true, service: 'badger-bikes', time: new Date(deps.now()).toISOString() })
    if (p === API_PATHS.meta)
      return json({ contactEmail: deps.contactEmail, version: deps.version, pushPublicKey: deps.push?.publicKey ?? null, stravaClientId: deps.strava?.clientId ?? null } satisfies MetaResponse)

    if (p.startsWith('/api/strava/') && method === 'POST') {
      await limit(deps.limiters?.strava, request)
      const app = deps.strava
      if (!app) throw new AppError('not_found', 'Strava is not set up on this server')
      const body = await readJsonBody(request)
      if (p === API_PATHS.stravaToken) return json(await stravaToken(deps.upstream, app, stravaTokenRequest(body), signal))
      if (p === API_PATHS.stravaUpload) return json({ uploadId: await stravaUpload(deps.upstream, stravaUploadRequest(body, deps.now()), signal) })
      if (p === API_PATHS.stravaUploadStatus) {
        const { accessToken, uploadId } = stravaUploadStatusRequest(body)
        return json(await stravaUploadStatus(deps.upstream, accessToken, uploadId, signal))
      }
      if (p === API_PATHS.stravaRevoke) {
        await stravaRevoke(deps.upstream, app, stravaRevokeRequest(body).token, signal)
        return json({ ok: true } satisfies OkResponse)
      }
    }

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

    if (p === API_PATHS.weather && method === 'GET') {
      await limit(deps.limiters?.geocode, request)
      const sys = requireSystem(url.searchParams.get('system'))
      // The city's center, never the rider's location (nothing about the rider is sent upstream).
      return json({ weather: await deps.fetchWeather(sys.center, sys.timezone, deps.upstream, { signal }) } satisfies WeatherResponse)
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
      const at = latLonParams(url.searchParams)
      // A pin far from every BCycle city is no place this app names: "Dropped pin", without asking the geocoder.
      if (!nearAnySystem(at)) return json({ place: null } satisfies ReverseResponse)
      return json({ place: await deps.reversePlace(at, deps.upstream, { signal }) })
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

    if (p === API_PATHS.loop && method === 'POST') {
      await limit(deps.limiters?.route, request)
      const { systemId: _s, priority, via, useRoads: _u, ...routeReq } = loopRequest(await readJsonBody(request))
      const router = deps.createRouter({ upstream: deps.upstream })
      try {
        const viaReq = via.map((v) => ({ coord: v.coord, ...(v.synthetic ? { searchCutoffMeters: LOOP.viaSearchCutoffMeters } : {}) }))
        const [route] = await router.routeLadder({ ...routeReq, via: viaReq }, [LOOP.useRoads], { signal, priority: priority ?? 'interactive' })
        if (!route) throw new AppError('no_route', 'No loop route.')
        count('routes')
        return json({ route: routeForApp(route) } satisfies LoopResponse)
      } catch (err) {
        const code = toAppError(err).code
        if (code === 'upstream_unavailable' || code === 'rate_limited') count('routes_busy')
        throw err
      }
    }

    if (p === API_PATHS.route && method === 'POST') {
      await limit(deps.limiters?.route, request)
      const { systemId: _s, priority, ...routeReq } = routeRequest(await readJsonBody(request))
      // The client asks for background priority: these legs are only drawn, never wait for them.
      const leg = await deps.createRouter({ upstream: deps.upstream }).route(routeReq, { signal, priority })
      return json({ route: routeForApp(leg) } satisfies RouteResponse)
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
      // The dashboard's first request of a page load (not its refreshes); counted before the cache answers.
      if (url.searchParams.get('view') === '1' && !BOT_UA.test(request.headers.get('User-Agent') ?? 'bot')) count('dashboard_views')
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
      const cors = corsHeaders(request.headers.get('Origin'))
      if (cors && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...PREFLIGHT_HEADERS } })
      let res: Response
      try {
        res = await handle(request)
      } catch (err) {
        res = errorResponse(err)
      }
      // Errors too, so the app can read their code (retryable, rate limited, …).
      if (cors) {
        for (const [name, value] of Object.entries(cors)) res.headers.set(name, value)
        res.headers.append('Vary', 'Origin')
      }
      return res
    },
  }
}
