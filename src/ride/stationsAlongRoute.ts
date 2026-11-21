// Pure: BCycle stations near a route, in route order.
import { RIDE, SPEEDS } from '../config'
import { bboxContains, bboxOf, buildPolylineIndex, haversine, nearestOnPolyline, type PolylineIndex } from '../lib/geo'
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
  return route.length < 2 ? [] : alongIndex(buildPolylineIndex([...route]), stations, excludeIds, corridorMeters, endRadiusMeters)
}

/** stationsAlongRoute on a route whose index is already built. */
function alongIndex(index: PolylineIndex, stations: readonly Station[], excludeIds: ReadonlySet<string>, corridorMeters: number, endRadiusMeters: number): StationOnRoute[] {
  const end = index.coords[index.coords.length - 1]!
  // Only stations within reach of the route's box are measured against every segment (most of a big city's
  // aren't). The box check is approximate, so its margin is generous: it may let a far station through, never
  // keep a near one out.
  const box = bboxOf(index.coords)
  const reach = Math.max(corridorMeters, endRadiusMeters) * 1.1 + 10
  const out: StationOnRoute[] = []
  for (const s of stations) {
    if (excludeIds.has(s.id) || !s.status?.isInstalled || (box && !bboxContains(box, s.coord, reach))) continue
    const snap = nearestOnPolyline(index, s.coord)
    if (snap && (snap.distanceFromLine <= corridorMeters || haversine(s.coord, end) <= endRadiusMeters)) out.push({ station: s, along: snap.distanceAlong, offset: snap.distanceFromLine })
  }
  return out.sort((a, b) => a.along - b.along)
}

/**
 * Riding seconds for `meters`. With `secondsPerMeter` (the chosen route's own pace: duration / distance,
 * so times match the route cards) that pace is used; otherwise the fixed speed model.
 */
export const rideSeconds = (meters: number, electric = false, secondsPerMeter?: number) =>
  secondsPerMeter && Number.isFinite(secondsPerMeter) && secondsPerMeter > 0 ? meters * secondsPerMeter : meters / (SPEEDS.bikeKph[electric ? 'electric' : 'classic'] / 3.6)

export interface RideSegment {
  fromId: string
  toId: string
  meters: number
  seconds: number
  overIncluded: boolean
}

/** Ride segments between consecutive stops (start → stop… → end), flagging ones longer than `maxMinutes`. */
export function rideSegments(startId: string, stops: readonly StationOnRoute[], maxMinutes: number | null, electric = false, secondsPerMeter?: number): RideSegment[] {
  const segs: RideSegment[] = []
  let prevId = startId
  let prevAlong = 0
  for (const s of stops) {
    const meters = Math.max(0, s.along - prevAlong) + s.offset
    const seconds = rideSeconds(meters, electric, secondsPerMeter)
    segs.push({ fromId: prevId, toId: s.station.id, meters, seconds, overIncluded: maxMinutes !== null && seconds > maxMinutes * 60 })
    prevId = s.station.id
    prevAlong = s.along
  }
  return segs
}

// ─── Strict dock selection ──────────────────────────────────────────────────────────────────────

/** Docks this close to the route line count as "on the route" (stations sit ≤ ~40 m from the path). */
export const ON_ROUTE_METERS = 50
/** Default longest ride between docks (the rider can change it in Settings: settings.maxRideMinutes). */
export const MAX_STRETCH_MINUTES = RIDE.defaultMaxRideMinutes
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
 * option wherever riding would exceed `maxRideMinutes` without a usable on-route dock, (b) the
 * dock closest to the destination when the last on-route dock leaves a walk over MAX_FINAL_WALK_METERS (however
 * far off the route, when it is closer to the destination than every dock already listed), and
 * (c) every dock in `keepIds` (stops the rider already chose), even when its live counts no longer qualify it:
 * a chosen dock that fills up stays in the plan (and is shown as full) instead of being silently swapped.
 */
export function routeDocks(
  route: readonly LngLat[],
  stations: readonly Station[],
  opts: {
    excludeIds?: ReadonlySet<string>
    keepIds?: readonly string[]
    destination: LngLat
    destStationId?: string
    partySize?: number
    electric?: boolean
    maxRideMinutes?: number
    secondsPerMeter?: number
  },
): RouteDock[] {
  if (route.length < 2) return []
  const exclude = opts.excludeIds ?? new Set<string>()
  const party = opts.partySize ?? 1
  // One index of the route for every lookup below.
  const index = buildPolylineIndex([...route])
  const total = index.total
  const wide = alongIndex(index, stations, exclude, REDOCK_SEARCH_METERS, 0)
  const docks: RouteDock[] = wide
    .filter((s) => s.offset <= ON_ROUTE_METERS && (s.along >= MIN_STOP_ALONG_METERS || s.station.id === opts.destStationId))
    .map((s) => ({ ...s, reason: 'onRoute' }))
  const has = (id: string) => docks.some((d) => d.station.id === id)
  // The destination dock (if the rider picked one) always counts.
  const destDock = opts.destStationId ? wide.find((s) => s.station.id === opts.destStationId) : undefined
  if (destDock && !has(destDock.station.id)) docks.push({ ...destDock, reason: 'onRoute' })

  // (a) Re-dock options for stretches longer than maxRideMinutes (0 = unlimited: none).
  const maxRide = opts.maxRideMinutes ?? MAX_STRETCH_MINUTES
  const maxStretch = maxRide > 0 ? (maxRide * 60) / rideSeconds(1, opts.electric, opts.secondsPerMeter) : Infinity
  let prev = 0
  for (; Number.isFinite(maxStretch); ) {
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

  // (c) Stops the rider already chose stay listed, whatever their counts are now. Added before (b): a kept dock
  // near the destination that still has room means no second one is added; one that filled up gets a usable
  // alternative listed next to it.
  const keep = (opts.keepIds ?? []).filter((id) => !exclude.has(id) && !has(id))
  for (const id of keep) {
    const station = stations.find((s) => s.id === id)
    const snap = station ? nearestOnPolyline(index, station.coord) : null
    if (!station || !snap) continue
    // Off the line: the end dock (the last chosen) or one within a short walk was picked for the destination.
    const nearDest = id === opts.keepIds?.at(-1) || haversine(station.coord, opts.destination) <= MAX_FINAL_WALK_METERS
    const reason: DockReason = snap.distanceFromLine <= ON_ROUTE_METERS ? 'onRoute' : nearDest ? 'nearDestination' : 'redock'
    docks.push({ station, along: snap.distanceAlong, offset: snap.distanceFromLine, reason })
  }

  // (b) Don't strand the rider far from the destination: the usable dock closest to it — wherever it is, when
  // no dock is within a short walk (a destination past the network's edge), as long as it beats every dock
  // already listed (a 1.5 km walk beats a 4.5 km one).
  const toDest = (c: LngLat) => haversine(c, opts.destination)
  const listed = docks.filter((d) => usableDock(d.station, party))
  const lastUsable = [...listed].sort((a, b) => b.along - a.along)[0]
  if (!lastUsable || toDest(lastUsable.station.coord) > MAX_FINAL_WALK_METERS) {
    const bestListed = Math.min(Infinity, ...listed.map((d) => toDest(d.station.coord)))
    const near = stations
      .filter((s) => !exclude.has(s.id) && !has(s.id) && usableDock(s, party) && toDest(s.coord) < bestListed)
      .sort((a, b) => toDest(a.coord) - toDest(b.coord))[0]
    if (near) {
      const snap = nearestOnPolyline(index, near.coord)
      docks.push({ station: near, along: snap?.distanceAlong ?? total, offset: snap?.distanceFromLine ?? 0, reason: 'nearDestination' })
    } else {
      // The closest is an off-route re-dock option already listed: it is where the ride ends, so say that.
      const best = listed.find((d) => toDest(d.station.coord) === bestListed)
      if (best?.reason === 'redock') best.reason = 'nearDestination'
    }
  }
  return docks.sort((a, b) => a.along - b.along)
}

/**
 * The optimized stops: the fewest docks that keep every ride between docks within `maxRideMinutes`
 * (0 = unlimited: just the end dock).
 * The ride ends at the usable dock closest to the destination (the destination dock when the rider chose
 * one); before it, the greedy pass re-docks at the farthest usable dock still within the limit. A stretch
 * with no usable dock in range is accepted as is (the UI flags it). Returns ids in ride order.
 */
export function optimizedStops(
  docks: readonly RouteDock[],
  opts: { destination: LngLat; destStationId?: string; partySize?: number; electric?: boolean; maxRideMinutes?: number; secondsPerMeter?: number },
): string[] {
  const party = opts.partySize ?? 1
  const usable = docks.filter((d) => usableDock(d.station, party))
  const end =
    usable.find((d) => d.station.id === opts.destStationId) ??
    [...usable].sort((a, b) => haversine(a.station.coord, opts.destination) - haversine(b.station.coord, opts.destination) || b.along - a.along)[0]
  if (!end) return []
  const maxRide = opts.maxRideMinutes ?? MAX_STRETCH_MINUTES
  const limitS = maxRide > 0 ? maxRide * 60 : Infinity
  const secs = (from: number, d: RouteDock) => rideSeconds(Math.max(0, d.along - from) + d.offset, opts.electric, opts.secondsPerMeter)
  const picks: RouteDock[] = []
  let prev = 0
  while (secs(prev, end) > limitS) {
    const before = usable.filter((d) => d.along > prev && d.along < end.along && d !== end)
    const inRange = before.filter((d) => secs(prev, d) <= limitS)
    // Farthest dock still within the limit; if none is in range, the next one (the long stretch is flagged).
    const next = inRange.length ? inRange.reduce((m, d) => (d.along > m.along ? d : m)) : before.sort((a, b) => a.along - b.along)[0]
    if (!next) break
    picks.push(next)
    prev = next.along
  }
  return [...picks, end].map((d) => d.station.id)
}
