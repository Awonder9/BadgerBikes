// HTTP API contract between the Cloudflare Worker (worker/) and the client (src/api/client.ts).
// Same origin in dev and prod; JSON everywhere; errors use ApiErrorBody with a 4xx/5xx status.
import type { Priority, USAGE } from '../config'
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
  usage: '/api/usage',
  analytics: '/api/analytics',
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

/** Something the app counts (USAGE.events). */
export type UsageEvent = (typeof USAGE.events)[number]
/** Something the Worker counts itself (USAGE.serverCounters). */
export type UsageCounter = (typeof USAGE.serverCounters)[number]
export type UsagePlatform = 'ios' | 'android' | 'desktop'

/**
 * Sent with a device's first open or check-in of the day (USAGE.timeZone): how many days since its previous
 * active day (null: never seen before), and coarse context. No identifier.
 */
export interface UsageFirst {
  gap: number | null
  systemId: string | null
  platform: UsagePlatform
  /** Running as the web app installed on the home screen (not a browser tab, not the iOS/Android app). */
  installed: boolean
  /** Running as the iOS/Android app (absent from versions of the web app older than the apps). */
  nativeApp?: boolean
  lang: Lang
}

/** POST /api/usage — anonymous usage counts (see USAGE in src/config.ts). Answer: OkResponse. */
export type UsageRequest =
  /** The app was opened (a page load); also a check-in for the current window. */
  | { kind: 'open'; first: UsageFirst | null }
  /** The app is open (visible) in a new USAGE.beatMs window. */
  | { kind: 'beat'; first: UsageFirst | null }
  | { kind: 'event'; name: UsageEvent }

/** One day of the dashboard (USAGE.timeZone). */
export interface StatsDay {
  /** YYYY-MM-DD */
  day: string
  /** Unique devices active that day, and in the 7 / 30 / 90 days ending that day. */
  users: number
  users7: number
  users30: number
  users90: number
  newUsers: number
  /** App opens (page loads). */
  opens: number
  /** Most devices with the app open in one USAGE.beatMs window. */
  peakActive: number
  /** Check-ins by hour of day (each is one device with the app open in one window). */
  beats: number[]
  counts: Partial<Record<UsageEvent | UsageCounter, number>>
  /**
   * Daily unique devices by city, platform, how they use it (the Home Screen web app; the iOS/Android app, by
   * platform; else a browser tab) and language.
   */
  cities: Record<string, number>
  platforms: Partial<Record<UsagePlatform, number>>
  installed: number
  apps: Partial<Record<UsagePlatform, number>>
  langs: Partial<Record<Lang, number>>
}

/** GET /api/analytics?days=N — the usage dashboard at /analytics (anonymous totals; cached briefly). */
export interface StatsResponse {
  timeZone: string
  generatedAtMs: number
  /** Devices that checked in during the current or the previous USAGE.beatMs window. */
  activeNow: number
  /** Unique devices since counting began. */
  allTimeUsers: number
  /** The first day with any counts (null: none yet). */
  since: string | null
  /** Oldest first, ending today. */
  days: StatsDay[]
}

