// Pure: BCycle stations near a route, in route order.
import { SPEEDS } from '../config'
import { buildPolylineIndex, haversine, nearestOnPolyline } from '../lib/geo'
import type { LngLat, Station } from '../types'

export interface StationOnRoute {
  station: Station
  /** Meters from the route start to the point nearest the station. */
  along: number
  /** Meters from the route to the station (the detour is roughly twice this). */
  offset: number
}

/** Default corridor: stations within this distance of the route are offered as stops. */
export const CORRIDOR_METERS = 250

/** Docks this close to the start (along the route) are not useful stops. */
export const MIN_STOP_ALONG_METERS = 400

/**
 * Stations within `corridorMeters` of `route`, ordered by distance along it. `excludeIds` (e.g. the start
 * dock) are skipped; stations that are not installed are dropped.
 */
export function stationsAlongRoute(route: readonly LngLat[], stations: readonly Station[], excludeIds: ReadonlySet<string> = new Set(), corridorMeters = CORRIDOR_METERS, endRadiusMeters = 0): StationOnRoute[] {
  if (route.length < 2) return []
  const index = buildPolylineIndex([...route])
  const end = route[route.length - 1]!
  const out: StationOnRoute[] = []
  for (const s of stations) {
    if (excludeIds.has(s.id) || !s.status?.isInstalled) continue
    const snap = nearestOnPolyline(index, s.coord)
    if (snap && (snap.distanceFromLine <= corridorMeters || haversine(s.coord, end) <= endRadiusMeters)) out.push({ station: s, along: snap.distanceAlong, offset: snap.distanceFromLine })
  }
  return out.sort((a, b) => a.along - b.along)
}

/** Riding seconds for `meters` along the route (the same speed model as the planner). */
export const rideSeconds = (meters: number, electric = false) => meters / (SPEEDS.bikeKph[electric ? 'electric' : 'classic'] / 3.6)

export interface RideSegment {
  fromId: string
  toId: string
  meters: number
  seconds: number
  overIncluded: boolean
}

/** Ride segments between consecutive stops (start → stop… → end), flagging ones longer than the pass allows. */
export function rideSegments(startId: string, stops: readonly StationOnRoute[], includedMinutes: number | null, electric = false): RideSegment[] {
  const segs: RideSegment[] = []
  let prevId = startId
  let prevAlong = 0
  for (const s of stops) {
    const meters = Math.max(0, s.along - prevAlong) + s.offset
    const seconds = rideSeconds(meters, electric)
    segs.push({ fromId: prevId, toId: s.station.id, meters, seconds, overIncluded: includedMinutes !== null && seconds > includedMinutes * 60 })
    prevId = s.station.id
    prevAlong = s.along
  }
  return segs
}

// ─── Strict dock selection ──────────────────────────────────────────────────────────────────────

/** Docks this close to the route line count as "on the route" (stations sit ≤ ~40 m from the path). */
export const ON_ROUTE_METERS = 50
/** Longest stretch of riding without a dock before an off-route re-dock option is added. */
export const MAX_STRETCH_MINUTES = 25
/** Corridor searched for that re-dock option. */
export const REDOCK_SEARCH_METERS = 300
/** If the last on-route dock leaves a longer walk than this, the dock closest to the destination is added. */
export const MAX_FINAL_WALK_METERS = 400

export type DockReason = 'onRoute' | 'redock' | 'nearDestination'

export interface RouteDock extends StationOnRoute {
  reason: DockReason
}

const usableDock = (s: Station, partySize: number) => !!s.status?.isInstalled && !!s.status.isReturning && (s.status.docks ?? 0) >= partySize

/**
 * Docks to show for a route, in ride order: only docks on the route line, plus (a) an off-route re-dock
 * option wherever riding would exceed MAX_STRETCH_MINUTES without a usable on-route dock, and (b) the
 * dock closest to the destination when the last on-route dock leaves a walk over MAX_FINAL_WALK_METERS.
 */
export function routeDocks(
  route: readonly LngLat[],
  stations: readonly Station[],
  opts: { excludeIds?: ReadonlySet<string>; destination: LngLat; destStationId?: string; partySize?: number; electric?: boolean },
): RouteDock[] {
  if (route.length < 2) return []
  const exclude = opts.excludeIds ?? new Set<string>()
  const party = opts.partySize ?? 1
  const total = buildPolylineIndex([...route]).total
  const wide = stationsAlongRoute(route, stations, exclude, REDOCK_SEARCH_METERS, 0)
  const docks: RouteDock[] = wide
    .filter((s) => s.offset <= ON_ROUTE_METERS && (s.along >= MIN_STOP_ALONG_METERS || s.station.id === opts.destStationId))
    .map((s) => ({ ...s, reason: 'onRoute' }))
  const has = (id: string) => docks.some((d) => d.station.id === id)
  // The destination dock (if the rider picked one) always counts.
  const destDock = opts.destStationId ? wide.find((s) => s.station.id === opts.destStationId) : undefined
  if (destDock && !has(destDock.station.id)) docks.push({ ...destDock, reason: 'onRoute' })

  // (a) Re-dock options for stretches longer than MAX_STRETCH_MINUTES.
  const maxStretch = (MAX_STRETCH_MINUTES * 60 * SPEEDS.bikeKph[opts.electric ? 'electric' : 'classic']) / 3.6
  let prev = 0
  for (;;) {
    const nextUsable = docks.filter((d) => d.along > prev && usableDock(d.station, party)).sort((a, b) => a.along - b.along)[0]
    const nextAlong = nextUsable?.along ?? total
    if (nextAlong - prev <= maxStretch) {
      if (!nextUsable) break
      prev = nextUsable.along
      continue
    }
    // Latest usable dock near the route before the limit (closest to the line on ties).
    const pick = wide
      .filter((s) => s.along > prev && s.along <= prev + maxStretch && !has(s.station.id) && usableDock(s.station, party))
      .sort((a, b) => b.along - a.along || a.offset - b.offset)[0]
    if (!pick) {
      if (!nextUsable) break
      prev = nextUsable.along // nothing nearby: accept the long stretch
      continue
    }
    docks.push({ ...pick, reason: 'redock' })
    prev = pick.along
  }

  // (b) Don't strand the rider far from the destination.
  const lastUsable = docks.filter((d) => usableDock(d.station, party)).sort((a, b) => b.along - a.along)[0]
  if (!lastUsable || haversine(lastUsable.station.coord, opts.destination) > MAX_FINAL_WALK_METERS) {
    const index = buildPolylineIndex([...route])
    const near = stations
      .filter((s) => !exclude.has(s.id) && !has(s.id) && usableDock(s, party) && haversine(s.coord, opts.destination) <= MAX_FINAL_WALK_METERS)
      .sort((a, b) => haversine(a.coord, opts.destination) - haversine(b.coord, opts.destination))[0]
    if (near) {
      const snap = nearestOnPolyline(index, near.coord)
      docks.push({ station: near, along: snap?.distanceAlong ?? total, offset: snap?.distanceFromLine ?? 0, reason: 'nearDestination' })
    }
  }
  return docks.sort((a, b) => a.along - b.along)
}

/** Default stops: every usable dock in the list (the rider unchecks what they don't want). */
export function preselectRouteDocks(docks: readonly RouteDock[], partySize = 1): string[] {
  return docks.filter((d) => usableDock(d.station, partySize)).map((d) => d.station.id)
}
