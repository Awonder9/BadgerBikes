// HTTP API contract between the Cloudflare Worker (worker/) and the client (src/api/client.ts).
// Same origin in dev and prod; JSON everywhere; errors use ApiErrorBody with a 4xx/5xx status.
import type { Priority } from '../config'
import type { Lang } from '../i18n/lang'
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
  pushRide: '/api/push/ride',
  pushCancel: '/api/push/cancel',
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
  /** VAPID public key (base64url) for background ride alerts; null when this server has none set up. */
  pushPublicKey: string | null
}

/** GET /api/locate — the BCycle system nearest the request's approximate (IP) location, or null. */
export interface LocateResponse {
  systemId: string | null
}

/**
 * `system` value for GET /api/stations on a first visit (no city chosen yet): the city nearest the request's
 * approximate (IP) location, else APP.defaultSystemId. The response's systemId says which city it picked, so
 * one round trip both picks the city and loads its stations.
 */
export const NEAREST_SYSTEM = 'nearest'

/** GET /api/stations?system=<id | NEAREST_SYSTEM> — merged station info + live status (plain arrays, no Maps). */
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

/** A browser push subscription, as PushSubscription.toJSON() gives it (keys base64url). */
export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * POST /api/push/ride — background alerts for the ride under way on this device (replaces its previous
 * ride): "time almost up" and "past your included time" from the ride timer, and "end dock full". The
 * server writes the alert text itself (in `lang`); it never sends text from the request.
 */
export interface PushRideRequest {
  subscription: PushSubscriptionJson
  lang: Lang
  systemId: string
  /** The dock the ride ends at (alert when it fills up), or null. */
  endStationId: string | null
  partySize: number
  /** When the BCycle ride started, epoch ms; null while walking to the dock (no timer alerts yet). */
  rideStartedAtMs: number | null
  /** Minutes included per ride by the rider's pass; null when unknown or pay-per-minute (no timer alerts). */
  includedMinutes: number | null
}

/** POST /api/push/cancel — stop this device's ride alerts. */
export interface PushCancelRequest {
  endpoint: string
}

/** Answer of the push endpoints. */
export interface OkResponse {
  ok: true
}
