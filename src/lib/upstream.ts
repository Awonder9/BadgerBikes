// The seam between pure data/routing/geocoding modules and the Worker's upstream access layer.
// Modules receive an UpstreamFetch; the Worker's implementation (worker/upstream.ts) adds the global
// rate gate (UpstreamGate Durable Object), the app User-Agent, and a two-tier cache. Tests pass a
// fixture-backed fake.
import type { Priority, UpstreamGroup } from '../config'

export interface UpstreamRequest {
  url: string
  /** Rate-limit group (UPSTREAM.groups); null = no gate (e.g. GBFS, which is CDN-backed). */
  group: UpstreamGroup | null
  priority: Priority
  /** For error attribution and logs: 'gbfs' | 'valhalla' | 'osrm' | 'photon'. */
  provider: string
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  /** JSON body for POST. */
  body?: unknown
  /** When set, successful responses are cached under this key. */
  cacheKey?: string
  /** Fixed TTL, or computed from the parsed body (e.g. station_status: until its CDN expiry). */
  cacheTtlMs?: number | ((body: unknown) => number)
  /** Overrides HTTP.timeoutMs (a slow upstream). */
  timeoutMs?: number
  /**
   * A form body (application/x-www-form-urlencoded) for POST instead of JSON (Strava's OAuth), or multipart form data
   * (Strava uploads).
   */
  form?: Record<string, string>
  multipart?: Array<{ name: string; value: string; fileName?: string; type?: string }>
  /** Extra request headers (e.g. an Authorization bearer token). Never part of the cache key. */
  headers?: Record<string, string>
}

/**
 * Resolves with the parsed JSON body of a 2xx response. Rejects with AppError:
 *   'aborted' | 'network' | 'timeout' | 'bad_response'
 *   'http' (status + parsed error body, e.g. Valhalla { error_code } / OSRM { code })
 *   'rate_limited' (HTTP 429 — the gate also opens its circuit)
 *   'upstream_unavailable' (circuit open, or no slot granted before the queue deadline)
 */
export type UpstreamFetch = <T>(req: UpstreamRequest) => Promise<T>
