// HTTP layer for /api/*. Dependencies are injected so handlers are testable in Node.
import { BIKE_ROUTING } from '../src/config'
import { API_PATHS, type LocateResponse, type MetaResponse, type StationsResponse } from '../src/api/contract'
import { nearestSystem } from '../src/data/systems'
import { isValidLngLat } from '../src/lib/geo'
import type { fetchStationsSnapshot as FetchStations, fetchSystemDetails as FetchSystem } from '../src/data/gbfs'
import { searchBias, type reversePlace as Reverse, type searchPlaces as Search } from '../src/geocode/photon'
import { AppError, toAppError, type AppErrorCode } from '../src/lib/errors'

import type { UpstreamFetch } from '../src/lib/upstream'
import type { AltRouter } from '../src/routing/types'
import { geocodeQuery, latLonParams, readJsonBody, requireSystem, routeDetailsRequest, routeRequest } from './validate'

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
  limiters?: { route?: RateLimit; geocode?: RateLimit }
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

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
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const p = url.pathname
    const method = request.method
    const signal = request.signal

    if (p === API_PATHS.health) return json({ ok: true, service: 'badger-bikes', time: new Date(deps.now()).toISOString() })
    if (p === API_PATHS.meta) return json({ contactEmail: deps.contactEmail, version: deps.version } satisfies MetaResponse)

    if (p === API_PATHS.locate && method === 'GET') {
      // Cloudflare's city-level estimate of where the request came from (no browser permission needed).
      const cf = (request as Request & { cf?: { latitude?: unknown; longitude?: unknown } }).cf
      const coord = [Number(cf?.longitude), Number(cf?.latitude)]
      const sys = isValidLngLat(coord) ? nearestSystem(coord) : null
      return json({ systemId: sys?.id ?? null } satisfies LocateResponse)
    }

    if (p === API_PATHS.stations && method === 'GET') {
      const sys = requireSystem(url.searchParams.get('system'))
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
      return json({ routes: await router.routeLadder(routeReq, BIKE_ROUTING.options.map((o) => o.useRoads), { signal, priority: priority ?? 'interactive' }) })
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
