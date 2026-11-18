// HTTP API contract between the Cloudflare Worker (worker/) and the client (src/api/client.ts).
// Same origin in dev and prod; JSON everywhere; errors use ApiErrorBody with a 4xx/5xx status.
import type { Priority } from '../config'
import type { RouteDetails } from '../routing/details'
import type { RouteRequest } from '../routing/types'
import type { Place, RouteLeg, Station, SystemDetails } from '../types'

export const API_PATHS = {
  health: '/api/health',
  meta: '/api/meta',
  stations: '/api/stations',
  system: '/api/system',
  routes: '/api/routes',
  locate: '/api/locate',
  routeDetails: '/api/route-details',
  geocode: '/api/geocode',
  reverse: '/api/reverse',
} as const

/** GET /api/health */
export interface HealthResponse {
  ok: true
  service: string
  time: string
}

/** GET /api/meta — operator info for the About sheet (FOSSGIS requires a reachable operator contact). */
export interface MetaResponse {
  contactEmail: string | null
  version: string
}

/** GET /api/locate — the BCycle system nearest the request's approximate (IP) location, or null. */
export interface LocateResponse {
  systemId: string | null
}

/** GET /api/stations?system=<id> — merged station info + live status (plain arrays, no Maps). */
export interface StationsResponse {
  systemId: string
  lastUpdatedMs: number
  fetchedAtMs: number
  stations: Station[]
}

/** GET /api/system?system=<id> */
export type SystemResponse = SystemDetails

/** POST /api/routes body: a bike route request (role 'ride') for a system. */
export interface RouteApiRequest extends RouteRequest {
  systemId: string
  priority?: Priority
}

/** GET /api/geocode?q=<text>&system=<id>[&lat=<lat>&lon=<lon>] (lat/lon = user position for biasing). */
export interface GeocodeResponse {
  places: Place[]
}

/** GET /api/reverse?lat=<lat>&lon=<lon> */
export interface ReverseResponse {
  /** null → the UI shows "Dropped pin". */
  place: Place | null
}

/** POST /api/routes → 3 route options: bike-friendly, balanced, fastest (BIKE_ROUTING.options order). */
export type RoutesApiRequest = RouteApiRequest

/** POST /api/route-details → path breakdown + elevation for one route (geometry as polyline6). */
export interface RouteDetailsRequest {
  systemId: string
  polyline: string
}
export type RouteDetailsResponse = RouteDetails

export interface RoutesResponse {
  routes: RouteLeg[]
}
