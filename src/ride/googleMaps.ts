// Google Maps hand-off (Maps URLs, no API key). A Maps URL cannot carry a route line — only an origin, a
// destination and ≤3 waypoints (mobile) — and Google computes its own path between them; every waypoint is a
// stop the rider must confirm in Google Maps. Docks are sent as the point on the route line, not the dock itself
// (a dock on a side street makes Google loop around the block). How much more Google is steered depends on the
// route option's hand-off (BIKE_ROUTING.options): 'docks' adds nothing, 'trails' a point on each trail/path
// section (where Google would most likely take a parallel road), 'exact' a point every maxGuidedGapMeters.
// Links are split so each has ≤3 waypoints.
import { BIKE_ROUTING, GOOGLE_HANDOFF } from '../config'
import { buildPolylineIndex, pointAlong } from '../lib/geo'
import type { LngLat, RouteLeg } from '../types'

/** How a route option steers Google Maps (BIKE_ROUTING.options[].handoff). */
export type Handoff = (typeof BIKE_ROUTING.options)[number]['handoff']

export const MAX_WAYPOINTS_MOBILE = GOOGLE_HANDOFF.maxWaypoints

export type TravelMode = 'bicycling' | 'walking'

const ll = (c: LngLat) => `${c[1].toFixed(6)},${c[0].toFixed(6)}`

export function directionsUrl(origin: LngLat, destination: LngLat, mode: TravelMode, waypoints: readonly LngLat[] = []): string {
  const q = new URLSearchParams({ api: '1', origin: ll(origin), destination: ll(destination), travelmode: mode })
  if (waypoints.length) q.set('waypoints', waypoints.map(ll).join('|'))
  return `https://www.google.com/maps/dir/?${q.toString()}`
}

/** Google Street View at a point (Maps URLs, no API key): the closest panorama Google has, e.g. of a dock. */
export function streetViewUrl(at: LngLat): string {
  const q = new URLSearchParams({ api: '1', map_action: 'pano', viewpoint: ll(at) })
  return `https://www.google.com/maps/@?${q.toString()}`
}

/** Directions from wherever the rider is now (Google uses the device location when origin is omitted). */
export function directionsFromHereUrl(destination: LngLat, mode: TravelMode): string {
  const q = new URLSearchParams({ api: '1', destination: ll(destination), travelmode: mode })
  return `https://www.google.com/maps/dir/?${q.toString()}`
}

export interface RideLink {
  kind: 'ride' | 'walk'
  label: string
  url: string
  /** Where this link ends: the dock's name, or null for a route point. */
  endLabel: string | null
  /** The link starts at a dock (the rider unlocks a bike there, so a new BCycle ride starts). */
  fromDock: boolean
}

/** A point Google is routed through, in ride order. The last one is the end dock. */
export interface RidePoint {
  coord: LngLat
  /** true = a dock the rider stops at; false = a via point that only keeps Google on the route. */
  isStop: boolean
  /** Dock name (stops only). */
  label?: string
}

const isLngLat = (p: RidePoint | LngLat): p is LngLat => Array.isArray(p)

/**
 * Bicycling links from the start dock through `points` (the last is the end dock), split so each link has
 * ≤ maxWaypoints waypoints. A link preferably ends at a dock stop (where the rider re-docks anyway) rather
 * than at a via point. Plus a walking link from the end dock to `walkTo`. `startIsDock` false: the ride starts
 * where the rider already is on a bike (the first link doesn't start at a dock).
 */
export function rideLinks(start: LngLat, points: ReadonlyArray<RidePoint | LngLat>, walkTo: LngLat | null, maxWaypoints = MAX_WAYPOINTS_MOBILE, startIsDock = true): RideLink[] {
  const pts: RidePoint[] = [{ coord: start, isStop: startIsDock }, ...points.map((p): RidePoint => (isLngLat(p) ? { coord: p, isStop: true } : p))]
  const last = pts.length - 1
  const chunks: RidePoint[][] = []
  for (let i = 0; i < last; ) {
    const maxEnd = Math.min(last, i + maxWaypoints + 1)
    let j = maxEnd
    if (maxEnd < last) {
      for (let k = maxEnd; k > i + 1; k--) {
        if (pts[k]!.isStop) {
          j = k
          break
        }
      }
    }
    chunks.push(pts.slice(i, j + 1))
    i = j
  }
  const links: RideLink[] = chunks.map((c, n) => {
    const end = c[c.length - 1]!
    return {
      kind: 'ride',
      label: chunks.length > 1 ? `Ride part ${n + 1} of ${chunks.length}` : 'Ride',
      url: directionsUrl(c[0]!.coord, end.coord, 'bicycling', c.slice(1, -1).map((p) => p.coord)),
      endLabel: end.isStop ? (end.label ?? null) : null,
      fromDock: c[0]!.isStop,
    }
  })
  if (walkTo) links.push({ kind: 'walk', label: 'Walk to destination', url: directionsUrl(pts[last]!.coord, walkTo, 'walking'), endLabel: null, fromDock: false })
  return links
}

export interface Waypoint {
  coord: LngLat
  /** Meters along the chosen route. */
  along: number
  /** true = a dock stop; false = a via point that keeps Google on the chosen route. */
  isStop: boolean
  label?: string
}

/** Street names that are bike paths / trails — where Google is most likely to cut over to a parallel road. */
export const TRAIL_NAME = /\b(path|trail|bikeway|greenway|cycleway|bike ?path|multi-?use)\b/i

/**
 * Via points that keep Google Maps on the chosen route: the longest stretch between consecutive guide
 * points (start, stops, earlier via points, end dock) is split until none is longer than `maxGap` (using
 * the fewest points), or `slots` via points are used. Points land on trail/path sections (`trailRanges`,
 * meters along the route) where that costs no extra point. `pointAt` maps along → coordinate.
 */
export function shapingPoints(
  stopAlongs: readonly number[],
  endAlong: number,
  slots: number,
  pointAt: (along: number) => LngLat,
  trailRanges: ReadonlyArray<readonly [number, number]> = [],
  maxGap: number = GOOGLE_HANDOFF.maxGuidedGapMeters,
): Waypoint[] {
  const marks = [0, ...stopAlongs.filter((a) => a > 0 && a < endAlong), endAlong].sort((a, b) => a - b)
  const placed: number[] = []
  for (let n = 0; n < slots; n++) {
    let best: { from: number; to: number } | null = null
    for (let i = 0; i < marks.length - 1; i++) {
      const from = marks[i]!
      const to = marks[i + 1]!
      if (to - from > maxGap && (!best || to - from > best.to - best.from)) best = { from, to }
    }
    if (!best) break
    // Fewest via points: this stretch needs k pieces of ≤ maxGap. The next point may go anywhere in
    // [to − (k−1)·maxGap, from + maxGap] — on a trail section there if possible, else at the even split.
    const k = Math.ceil((best.to - best.from) / maxGap)
    // (Never hug the stretch's ends: a point right next to a dock guides nothing.)
    const winLo = Math.max(best.from + maxGap / 4, best.to - (k - 1) * maxGap)
    const winHi = Math.min(best.to - maxGap / 4, best.from + maxGap)
    let along = best.from + (best.to - best.from) / k
    let trail = Math.min(150, winHi - winLo) - 1 // ignore slivers of trail
    for (const [a, b] of trailRanges) {
      const lo = Math.max(a, winLo)
      const hi = Math.min(b, winHi)
      if (b > a && hi - lo > trail) {
        trail = hi - lo
        along = (lo + hi) / 2
      }
    }
    placed.push(along)
    marks.push(along)
    marks.sort((a, b) => a - b)
  }
  return placed.sort((a, b) => a - b).map((along) => ({ coord: pointAt(along), along, isStop: false }))
}

/**
 * 'trails' hand-off: via points only on trail/path sections (`trailRanges`, meters along the route), where
 * Google would most likely take a parallel road instead. Ranges less than trailJoinGapMeters apart are one
 * section; a section shorter than trailMinMeters gets none, a longer one a point per trailPointEveryMeters
 * (at least one), evenly spread. Points within trailNearStopMeters of a dock stop or either end are dropped (the
 * dock already anchors that stretch). At most `slots` points.
 */
export function trailPoints(
  stopAlongs: readonly number[],
  endAlong: number,
  slots: number,
  pointAt: (along: number) => LngLat,
  trailRanges: ReadonlyArray<readonly [number, number]>,
): Waypoint[] {
  const H = GOOGLE_HANDOFF
  const sections: Array<[number, number]> = []
  for (const [a, b] of trailRanges.filter(([from, to]) => to > from).sort((x, y) => x[0] - y[0])) {
    const last = sections.at(-1)
    if (last && a - last[1] <= H.trailJoinGapMeters) last[1] = Math.max(last[1], b)
    else sections.push([a, b])
  }
  const anchors = [0, ...stopAlongs, endAlong]
  const placed: number[] = []
  for (const [a, b0] of sections) {
    const b = Math.min(b0, endAlong)
    const len = b - a
    if (len < H.trailMinMeters) continue
    const k = Math.max(1, Math.round(len / H.trailPointEveryMeters))
    for (let i = 0; i < k; i++) {
      const along = a + ((i + 0.5) * len) / k
      if (anchors.every((s) => Math.abs(s - along) >= H.trailNearStopMeters)) placed.push(along)
    }
  }
  return placed.slice(0, slots).map((along) => ({ coord: pointAt(along), along, isStop: false }))
}

/** Valhalla's wording for unnamed bike-only ways ("Turn left onto the cycleway."). */
const UNNAMED_PATH = /\bthe (cycleway|path|footway|walkway)\b/i

const isTrailStep = (m: { streetNames?: string[]; instruction?: string }) =>
  (m.streetNames ?? []).some((n) => TRAIL_NAME.test(n)) || (!m.streetNames?.length && UNNAMED_PATH.test(m.instruction ?? ''))

/** Along-route ranges [from, to] of maneuver steps on trails/paths, named or not (`cum` = meters at each vertex). */
export function trailRangesOf(maneuvers: ReadonlyArray<{ streetNames?: string[]; instruction?: string; beginIndex: number; endIndex: number }>, cum: ArrayLike<number>): Array<[number, number]> {
  return maneuvers
    .filter((m) => m.endIndex > m.beginIndex && isTrailStep(m))
    .map((m) => [cum[m.beginIndex] ?? 0, cum[m.endIndex] ?? 0])
}

/** Via points for one hand-off style (none for 'docks'). */
function viaPoints(handoff: Handoff, stopAlongs: readonly number[], endAlong: number, pointAt: (along: number) => LngLat, trailRanges: ReadonlyArray<readonly [number, number]>): Waypoint[] {
  if (handoff === 'docks') return []
  if (handoff === 'trails') return trailPoints(stopAlongs, endAlong, GOOGLE_HANDOFF.maxViaPoints, pointAt, trailRanges)
  // A loop has no destination to aim Google at (it may end where it starts): it is held to the loop's shape.
  if (handoff === 'loop') return shapingPoints(stopAlongs, endAlong, GOOGLE_HANDOFF.maxViaPoints, pointAt, trailRanges, GOOGLE_HANDOFF.loopGuidedGapMeters)
  return shapingPoints(stopAlongs, endAlong, GOOGLE_HANDOFF.maxViaPoints, pointAt, trailRanges)
}

/**
 * Waypoints (via points) a route gets with this hand-off, counted from the start to the route's end without dock
 * stops — the route cards' "N waypoints" (the chosen docks can only remove some).
 */
export function viaPointCount(route: Pick<RouteLeg, 'geometry' | 'maneuvers'>, handoff: Handoff): number {
  if (handoff === 'docks') return 0
  const index = buildPolylineIndex(route.geometry)
  return viaPoints(handoff, [], index.total, (a) => pointAlong(index, a).point, trailRangesOf(route.maneuvers, index.cum)).length
}

/**
 * Google waypoints for a ride: each chosen dock (sent as the point on the route line when it is that close,
 * so Google doesn't detour around the block to reach it; the end dock keeps its real location) plus the
 * hand-off's via points.
 */
export function guidePoints(
  stops: ReadonlyArray<{ coord: LngLat; along: number; offset: number; name?: string }>,
  pointAt: (along: number) => LngLat,
  trailRanges: ReadonlyArray<readonly [number, number]> = [],
  handoff: Handoff = 'exact',
): RidePoint[] {
  const end = stops.at(-1)
  if (!end) return []
  const vias = viaPoints(
    handoff,
    stops.slice(0, -1).map((s) => s.along),
    end.along,
    pointAt,
    trailRanges,
  )
  const docks: Waypoint[] = stops.map((s, i) => ({
    coord: i < stops.length - 1 && s.offset <= GOOGLE_HANDOFF.snapToRouteMeters ? pointAt(s.along) : s.coord,
    along: s.along,
    isStop: true,
    ...(s.name ? { label: s.name } : {}),
  }))
  return [...docks.slice(0, -1), ...vias]
    .filter((w) => w.along <= end.along)
    .sort((a, b) => a.along - b.along)
    .map((w): RidePoint => ({ coord: w.coord, isStop: w.isStop, ...(w.label ? { label: w.label } : {}) }))
    .concat({ coord: end.coord, isStop: true, ...(end.name ? { label: end.name } : {}) })
}
