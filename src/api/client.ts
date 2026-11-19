// Typed client for the Worker API (same origin), plus the one direct third-party call: place search to
// Photon (see api.geocode). The only place the browser makes requests besides map tiles. All calls reject
// with AppError (see src/lib/errors.ts).
import { ENDPOINTS, GEOCODE, SYSTEM_DETECT } from '../config'
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
  type MetaResponse,
  type OkResponse,
  type PushRideRequest,
  type ReverseResponse,
  type RoutesApiRequest,
  type RouteDetailsResponse,
  type RoutesResponse,
  type StationsResponse,
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

export const api = {
  stations(systemId: string, signal?: AbortSignal): Promise<StationsResponse> {
    return fetchJson<StationsResponse>(`${API_PATHS.stations}${qs({ system: systemId })}`, { signal, cache: 'no-store', provider: PROVIDER })
  },

  system(systemId: string, signal?: AbortSignal): Promise<SystemDetails> {
    return fetchJson<SystemDetails>(`${API_PATHS.system}${qs({ system: systemId })}`, { signal, provider: PROVIDER })
  },

  meta(signal?: AbortSignal): Promise<MetaResponse> {
    return fetchJson<MetaResponse>(API_PATHS.meta, { signal, provider: PROVIDER })
  },

  async locate(signal?: AbortSignal): Promise<string | null> {
    return (await fetchJson<LocateResponse>(API_PATHS.locate, { signal, provider: PROVIDER, timeoutMs: SYSTEM_DETECT.timeoutMs })).systemId
  },

  routeDetails(systemId: string, polyline: string, signal?: AbortSignal): Promise<RouteDetailsResponse> {
    return postJson<RouteDetailsResponse>(API_PATHS.routeDetails, { systemId, polyline }, { signal, provider: PROVIDER })
  },

  async routes(body: RoutesApiRequest, signal?: AbortSignal): Promise<RouteLeg[]> {
    return (await postJson<RoutesResponse>(API_PATHS.routes, body, { signal, provider: PROVIDER })).routes
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
      `${API_PATHS.geocode}${qs({ q: query, system: systemId, lat: near?.[1].toFixed(GEOCODE.biasDecimals), lon: near?.[0].toFixed(GEOCODE.biasDecimals) })}`,
      { signal, provider: PROVIDER },
    )
    return res.places
  },

  /** Background alerts for the ride under way on this device (replaces its previous ride). */
  async pushRide(body: PushRideRequest, signal?: AbortSignal): Promise<void> {
    await postJson<OkResponse>(API_PATHS.pushRide, body, { signal, provider: PROVIDER })
  },

  /** The ride ended: no more background alerts for this device. */
  async pushCancel(endpoint: string, signal?: AbortSignal): Promise<void> {
    await postJson<OkResponse>(API_PATHS.pushCancel, { endpoint }, { signal, provider: PROVIDER })
  },

  async reverse(coord: LngLat, signal?: AbortSignal): Promise<Place | null> {
    const res = await fetchJson<ReverseResponse>(`${API_PATHS.reverse}${qs({ lat: coord[1].toFixed(5), lon: coord[0].toFixed(5) })}`, {
      signal,
      provider: PROVIDER,
    })
    return res.place
  },
}

export type Api = typeof api
