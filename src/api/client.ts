// Typed client for the Worker API (same origin; from the native apps, the deployed site), plus the one direct
// third-party call: place search to Photon (see api.geocode). The only place the browser makes requests besides
// map tiles. All calls reject with AppError (see src/lib/errors.ts).
import { ENDPOINTS, GEOCODE, NATIVE_APP, SYSTEM_DETECT } from '../config'
import { getSystem } from '../data/systems'
import { searchBias, searchPlaces } from '../geocode/photon'
import { fetchJson, postJson } from '../lib/http'
import { HostScheduler } from '../lib/rateLimiter'
import type { UpstreamFetch, UpstreamRequest } from '../lib/upstream'
import type { LngLat, Place, RouteLeg, SystemDetails } from '../types'
import {
  API_PATHS,
  type GeocodeResponse,
  type LocateResponse,
  type StravaTokenRequest,
  type StravaTokenResponse,
  type StravaUploadRequest,
  type StravaUploadResponse,
  type StravaUploadStatusRequest,
  type StravaUploadStatusResponse,
  type LoopApiRequest,
  type LoopResponse,
  type MetaResponse,
  type OkResponse,
  type PushRideRequest,
  type ReverseResponse,
  type RouteApiRequest,
  type RouteResponse,
  type RoutesApiRequest,
  type RouteDetailsResponse,
  type RoutesResponse,
  type StationsResponse,
  type StatsResponse,
  type UsageRequest,
  type WeatherResponse,
} from './contract'

const PROVIDER = 'api'

/** Direct browser → Photon requests are spaced out (shared campus/office IPs are throttled together). */
const photonScheduler = new HostScheduler(GEOCODE.directMinIntervalMs)

/** UpstreamFetch for calls the browser makes itself (only Photon search; see api.geocode). */
const directUpstream: UpstreamFetch = <T>(req: UpstreamRequest) =>
  photonScheduler.schedule(() => fetchJson<T>(req.url, { signal: req.signal, provider: req.provider, timeoutMs: GEOCODE.directTimeoutMs }), req.signal)

/** The CSP (public/_headers) allows only the public Photon host; a custom VITE_PHOTON_URL goes via the Worker. */
const DIRECT_PHOTON = new URL(ENDPOINTS.photon).host === 'photon.komoot.io'

function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/**
 * An /api/* URL: relative in the web app (the page's own origin serves the API); absolute in the native apps,
 * whose page is served from the phone, so their requests go to the deployed site (NATIVE_APP.webOrigin).
 */
function apiUrl(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  return `${NATIVE_APP.webOrigin}${path}${qs(params)}`
}

export const api = {
  stations(systemId: string, signal?: AbortSignal): Promise<StationsResponse> {
    return fetchJson<StationsResponse>(apiUrl(API_PATHS.stations, { system: systemId }), { signal, cache: 'no-store', provider: PROVIDER })
  },

  system(systemId: string, signal?: AbortSignal): Promise<SystemDetails> {
    return fetchJson<SystemDetails>(apiUrl(API_PATHS.system, { system: systemId }), { signal, provider: PROVIDER })
  },

  meta(signal?: AbortSignal): Promise<MetaResponse> {
    return fetchJson<MetaResponse>(apiUrl(API_PATHS.meta), { signal, provider: PROVIDER })
  },

  async locate(signal?: AbortSignal): Promise<string | null> {
    return (await fetchJson<LocateResponse>(apiUrl(API_PATHS.locate), { signal, provider: PROVIDER, timeoutMs: SYSTEM_DETECT.timeoutMs })).systemId
  },

  routeDetails(systemId: string, polyline: string, signal?: AbortSignal): Promise<RouteDetailsResponse> {
    return postJson<RouteDetailsResponse>(apiUrl(API_PATHS.routeDetails), { systemId, polyline }, { signal, provider: PROVIDER })
  },

  async routes(body: RoutesApiRequest, signal?: AbortSignal): Promise<RouteLeg[]> {
    return (await postJson<RoutesResponse>(apiUrl(API_PATHS.routes), body, { signal, provider: PROVIDER })).routes
  },

  /** "Just ride": one bike route through the loop's via points (src/routing/loop.ts picks them). */
  async loop(body: LoopApiRequest, signal?: AbortSignal): Promise<RouteLeg> {
    return (await postJson<LoopResponse>(apiUrl(API_PATHS.loop), body, { signal, provider: PROVIDER })).route
  },

  async weather(systemId: string, signal?: AbortSignal): Promise<WeatherResponse['weather']> {
    return (await fetchJson<WeatherResponse>(apiUrl(API_PATHS.weather, { system: systemId }), { signal, provider: PROVIDER })).weather
  },

  /** One leg (a walk, or the ride's last stretch to an off-route dock), for drawing it on the map. */
  async route(body: RouteApiRequest, signal?: AbortSignal): Promise<RouteLeg> {
    return (await postJson<RouteResponse>(apiUrl(API_PATHS.route), body, { signal, provider: PROVIDER })).route
  },

  /**
   * Place search. Asks Photon directly from the browser first: Photon throttles by IP, and Cloudflare
   * Workers share their outgoing IPs, so through the Worker about a third of searches failed or stalled.
   * The rider's own IP is fast and reliable. Falls back to the Worker (/api/geocode) if that fails.
   */
  async geocode(query: string, systemId: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
    const sys = getSystem(systemId)
    if (sys && DIRECT_PHOTON) {
      try {
        return await searchPlaces(query, searchBias(sys, near), directUpstream, { signal })
      } catch (err) {
        if (signal?.aborted) throw err
        /* fall through to the Worker */
      }
    }
    return api.geocodeViaWorker(query, systemId, near, signal)
  },

  async geocodeViaWorker(query: string, systemId: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
    const res = await fetchJson<GeocodeResponse>(
      apiUrl(API_PATHS.geocode, { q: query, system: systemId, lat: near?.[1].toFixed(GEOCODE.biasDecimals), lon: near?.[0].toFixed(GEOCODE.biasDecimals) }),
      { signal, provider: PROVIDER },
    )
    return res.places
  },

  /** Background alerts for the ride under way on this device (replaces its previous ride). */
  async pushRide(body: PushRideRequest, signal?: AbortSignal): Promise<void> {
    await postJson<OkResponse>(apiUrl(API_PATHS.pushRide), body, { signal, provider: PROVIDER })
  },

  /** The ride ended: no more background alerts for this device. */
  async pushCancel(endpoint: string, signal?: AbortSignal): Promise<void> {
    await postJson<OkResponse>(apiUrl(API_PATHS.pushCancel), { endpoint }, { signal, provider: PROVIDER })
  },

  /** Strava: exchange an authorization code, or refresh (the Worker holds the client secret). */
  stravaToken(body: StravaTokenRequest, signal?: AbortSignal): Promise<StravaTokenResponse> {
    return postJson<StravaTokenResponse>(apiUrl(API_PATHS.stravaToken), body, { signal, provider: PROVIDER })
  },

  /** Strava: one ride as an activity (the Worker builds the GPX file); poll stravaUploadStatus after. */
  stravaUpload(body: StravaUploadRequest, signal?: AbortSignal): Promise<StravaUploadResponse> {
    return postJson<StravaUploadResponse>(apiUrl(API_PATHS.stravaUpload), body, { signal, provider: PROVIDER, timeoutMs: 30_000 })
  },

  stravaUploadStatus(body: StravaUploadStatusRequest, signal?: AbortSignal): Promise<StravaUploadStatusResponse> {
    return postJson<StravaUploadStatusResponse>(apiUrl(API_PATHS.stravaUploadStatus), body, { signal, provider: PROVIDER })
  },

  async stravaRevoke(token: string): Promise<void> {
    await postJson<OkResponse>(apiUrl(API_PATHS.stravaRevoke), { token }, { provider: PROVIDER })
  },

  /** An anonymous usage report (src/ui/usage.ts). */
  async usage(report: UsageRequest): Promise<void> {
    await postJson<OkResponse>(apiUrl(API_PATHS.usage), report, { provider: PROVIDER })
  },

  /** The usage dashboard's numbers (/analytics). */
  /** `view`: this is the dashboard page being opened (counted as a view; its refreshes aren't). */
  analytics(days: number, signal?: AbortSignal, view = false): Promise<StatsResponse> {
    return fetchJson<StatsResponse>(apiUrl(API_PATHS.analytics, view ? { days, view: 1 } : { days }), { signal, provider: PROVIDER, cache: 'no-store' })
  },

  async reverse(coord: LngLat, signal?: AbortSignal): Promise<Place | null> {
    const res = await fetchJson<ReverseResponse>(apiUrl(API_PATHS.reverse, { lat: coord[1].toFixed(5), lon: coord[0].toFixed(5) }), {
      signal,
      provider: PROVIDER,
    })
    return res.place
  },
}

export type Api = typeof api
