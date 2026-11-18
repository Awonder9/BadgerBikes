// Typed client for the Worker API (same origin). The only place the browser makes requests besides
// map tiles. All calls reject with AppError (see src/lib/errors.ts).
import { SYSTEM_DETECT } from '../config'
import { fetchJson, postJson } from '../lib/http'
import type { LngLat, Place, RouteLeg, SystemDetails } from '../types'
import {
  API_PATHS,
  type GeocodeResponse,
  type LocateResponse,
  type MetaResponse,
  type ReverseResponse,
  type RoutesApiRequest,
  type RoutesResponse,
  type StationsResponse,
} from './contract'

const PROVIDER = 'api'

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

  async routes(body: RoutesApiRequest, signal?: AbortSignal): Promise<RouteLeg[]> {
    return (await postJson<RoutesResponse>(API_PATHS.routes, body, { signal, provider: PROVIDER })).routes
  },

  async geocode(query: string, systemId: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
    const res = await fetchJson<GeocodeResponse>(
      `${API_PATHS.geocode}${qs({ q: query, system: systemId, lat: near?.[1].toFixed(5), lon: near?.[0].toFixed(5) })}`,
      { signal, provider: PROVIDER },
    )
    return res.places
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
