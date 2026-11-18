// Router contract (implemented in src/routing, used by the planner inside the Worker and — via
// POST /api/route — by the client for reroutes).
import type { Priority } from '../config'
import type { LegRole, LngLat, RouteLeg, TravelMode, Units } from '../types'

export type BikeKind = 'classic' | 'electric'

export interface RouteRequest {
  role: LegRole
  mode: TravelMode
  from: LngLat
  to: LngLat
  /** Valhalla bakes units/language into verbal text; both are part of the cache key. */
  units: Units
  language: string
  /** Current course in degrees, sent only for bike reroutes with a reliable course (avoids "Make a U-turn"). */
  headingDeg?: number
  /** toPickup → pickup station id; ride → dropoff station id. Copied onto the leg. */
  stationId?: string
  /** User-supplied points (my location, search result, map pick) get a tight snap cutoff; stations do not. */
  fromIsUserPoint?: boolean
  toIsUserPoint?: boolean
  /** Bike speed model (SPEEDS.bikeKph); defaults to 'classic'. */
  bikeKind?: BikeKind
  /** Valhalla use_roads 0–1 for bike legs (0 = avoid car roads); defaults to BIKE_ROUTING.defaultUseRoads. */
  useRoads?: number
}

export interface RequestOpts {
  signal?: AbortSignal
  /** Upstream queue priority: interactive (route options, searches) > background. */
  priority?: Priority
}

/**
 * Router facade (src/routing/router.ts).
 *
 * route(): Valhalla → on network | timeout | rate_limited | upstream_unavailable | 5xx: OSRM route
 *   → otherwise a straight leg (provider 'straight', maneuvers [depart, arrive]).
 *   Rejects ONLY with AppError 'aborted', or 'location_unroutable' when a user-supplied point is too far
 *   from any street/path (Valhalla 170/171 with search_cutoff, OSRM NoSegment with radiuses).
 *
 * All distances in meters, durations in seconds, regardless of requested units. Results are cached
 * (key: provider|endpoint|mode|bikeKind|units|language|coordinates rounded to 5 dp).
 */
export interface Router {
  route(req: RouteRequest, opts?: RequestOpts): Promise<RouteLeg>
}

/** Router that can also return bike route options at several use_roads levels (see BIKE_ROUTING.options). */
export interface AltRouter extends Router {
  /**
   * One route per `useRoads` level, in the given order; the last is replaced by the quickest of all.
   * Rejects like route(), and with 'upstream_unavailable' when any option could only be estimated
   * (routing servers busy or down).
   */
  routeLadder(req: RouteRequest, levels: readonly number[], opts?: RequestOpts): Promise<RouteLeg[]>
}
