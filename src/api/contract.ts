// HTTP API contract between the Cloudflare Worker (worker/) and the client (src/api/client.ts).
// Same origin in dev and prod; JSON everywhere; errors use ApiErrorBody with a 4xx/5xx status.
import type { Priority, USAGE } from '../config'
import type { Lang } from '../i18n/lang'
import type { RouteDetails } from '../routing/details'
import type { RouteRequest } from '../routing/types'
import type { Weather } from '../weather/openMeteo'
import type { LngLat, Place, RouteLeg, Station, SystemDetails } from '../types'

export const API_PATHS = {
  health: '/api/health',
  meta: '/api/meta',
  stations: '/api/stations',
  system: '/api/system',
  routes: '/api/routes',
  route: '/api/route',
  loop: '/api/loop',
  weather: '/api/weather',
  locate: '/api/locate',
  routeDetails: '/api/route-details',
  geocode: '/api/geocode',
  reverse: '/api/reverse',
  pushRide: '/api/push/ride',
  pushCancel: '/api/push/cancel',
  usage: '/api/usage',
  stravaToken: '/api/strava/token',
  stravaUpload: '/api/strava/upload',
  stravaUploadStatus: '/api/strava/upload-status',
  stravaRevoke: '/api/strava/revoke',
  analytics: '/api/analytics',
} as const

/** GET /api/weather?system=<id> → the city's current weather, wind, and today's sunrise/sunset (its center). */
export interface WeatherResponse {
  weather: Weather
}

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
  /** The Strava app's client id for "Send to Strava"; null when this server has none set up (the feature is hidden). */
  stravaClientId?: string | null
}

/**
 * POST /api/strava/token — `{ code }` (from Strava's OAuth redirect) or `{ refreshToken }`. The Worker adds the app's
 * client secret; nothing is stored there. 401 unauthorized: the rider must connect again.
 */
export type StravaTokenRequest = { code: string } | { refreshToken: string }

export interface StravaTokenResponse {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  scope?: string
  /** The athlete's first name, for "Connected as …". */
  athleteName: string | null
}

/**
 * POST /api/strava/upload — one ride as a Strava activity. The Worker builds the GPX file from `polyline` (the route as
 * planned, polyline6) with times spread from `startedAtMs` over `elapsedS`, and appends a note in `lang` saying it is
 * the planned route. Answer: StravaUploadResponse; then poll /api/strava/upload-status.
 */
export interface StravaUploadRequest {
  accessToken: string
  lang: Lang
  polyline: string
  startedAtMs: number
  elapsedS: number
  name: string
  description: string
  sportType: 'Ride' | 'EBikeRide'
  commute: boolean
  /** "badgerbikes-<ride id>": the same ride is never sent twice as two activities. */
  externalId: string
}

export interface StravaUploadResponse {
  uploadId: string
}

/** POST /api/strava/upload-status */
export interface StravaUploadStatusRequest {
  accessToken: string
  uploadId: string
}

export interface StravaUploadStatusResponse {
  state: 'processing' | 'ready' | 'duplicate' | 'error'
  /** The activity (ready), or the existing one it duplicates. */
  activityId: string | null
}

/** POST /api/strava/revoke — disconnect: the token (and the app's access) stops working. Answer: OkResponse. */
export interface StravaRevokeRequest {
  token: string
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

/** POST /api/routes → one route per BIKE_ROUTING.options entry, in order (direct, bike-friendly). */
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

/**
 * POST /api/route (body: RouteApiRequest) → one leg, for drawing: the walks to the pickup dock and from the end
 * dock, and the ride's last stretch to an off-route end dock (the client asks for background priority). When
 * both routers fail the leg is a straight line (provider 'straight').
 */
export interface RouteResponse {
  route: RouteLeg
}

/**
 * POST /api/loop — "Just ride": one bike route from `from` through `via` (in order, without stopping) to `to` (the
 * start dock again for a loop), at LOOP.useRoads (as far from car traffic as possible). The client picks the via
 * points (src/routing/loop.ts); `synthetic` ones may snap further to a street or path. `useRoads` is ignored.
 * Errors like POST /api/routes: 422 no_route, 503 upstream_unavailable.
 */
export interface LoopApiRequest extends RouteApiRequest {
  via: Array<{ coord: LngLat; synthetic: boolean }>
}

export interface LoopResponse {
  route: RouteLeg
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
  /** Times the dashboard was opened since counting them began (per day: `counts.dashboard_views`). */
  dashboardViews: { allTime: number; since: string | null }
  /** Oldest first, ending today. */
  days: StatsDay[]
}

