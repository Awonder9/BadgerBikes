// Pure geometry helpers. Coordinates are [lon, lat]; distances are meters; bearings are degrees
// clockwise from true north in [0, 360).
import type { LngLat } from '../types'

/** Mean Earth radius in meters (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8

export const toRad = (deg: number) => (deg * Math.PI) / 180
export const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Great-circle distance in meters. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLon = toRad(b[0] - a[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return normalizeBearing(toDeg(Math.atan2(y, x)))
}

export function normalizeBearing(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(normalizeBearing(a) - normalizeBearing(b))
  return d > 180 ? 360 - d : d
}

/** Point reached by travelling `distance` meters from `origin` on initial bearing `bearingDeg`. */
export function destination(origin: LngLat, distance: number, bearingDeg: number): LngLat {
  const δ = distance / EARTH_RADIUS_M
  const θ = toRad(bearingDeg)
  const φ1 = toRad(origin[1])
  const λ1 = toRad(origin[0])
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [((toDeg(λ2) + 540) % 360) - 180, toDeg(φ2)]
}

/** Linear interpolation between two coordinates (fine for the short segments of a route). */
export function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

export interface SegmentProjection {
  /** Closest point on segment ab to p. */
  point: LngLat
  /** Position of `point` along ab in [0, 1]. */
  t: number
  /** Distance from p to `point` in meters. */
  distance: number
}

/** Meters per degree of latitude (and of longitude at the equator) on the haversine sphere. */
const METERS_PER_DEGREE = EARTH_RADIUS_M * (Math.PI / 180)

/**
 * Projects p onto segment ab using a local equirectangular approximation centred on p
 * (sub-meter accurate for segments up to a few km, which covers routing geometry).
 */
export function projectToSegment(p: LngLat, a: LngLat, b: LngLat): SegmentProjection {
  const kx = Math.cos(toRad(p[1])) * METERS_PER_DEGREE
  const ky = METERS_PER_DEGREE
  const ax = (a[0] - p[0]) * kx
  const ay = (a[1] - p[1]) * ky
  const bx = (b[0] - p[0]) * kx
  const by = (b[1] - p[1]) * ky
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const point = lerp(a, b, t)
  return { point, t, distance: haversine(p, point) }
}

/** Precomputed cumulative distances along a polyline for fast progress queries. */
export interface PolylineIndex {
  coords: LngLat[]
  /** cum[i] = meters from coords[0] to coords[i]. Same length as coords. */
  cum: number[]
  /** Total length in meters. */
  total: number
}

export function buildPolylineIndex(coords: LngLat[]): PolylineIndex {
  const cum: number[] = []
  let total = 0
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) total += haversine(coords[i - 1]!, coords[i]!)
    cum.push(total)
  }
  return { coords, cum, total }
}

export interface PolylineSnap {
  point: LngLat
  /** Index of the segment [segmentIndex, segmentIndex + 1] containing `point`. */
  segmentIndex: number
  t: number
  /** Meters from the start of the polyline to `point`. */
  distanceAlong: number
  /** Meters from the query point to `point`. */
  distanceFromLine: number
}

/**
 * Nearest point on the polyline to p. Optionally restricts the search to the part of the line
 * between `fromDistance` and `toDistance` meters along it (used for forward-only snapping).
 */
export function nearestOnPolyline(
  index: PolylineIndex,
  p: LngLat,
  opts: { fromDistance?: number; toDistance?: number } = {},
): PolylineSnap | null {
  const { coords, cum } = index
  if (coords.length === 0) return null
  if (coords.length === 1) {
    return { point: coords[0]!, segmentIndex: 0, t: 0, distanceAlong: 0, distanceFromLine: haversine(p, coords[0]!) }
  }
  const from = opts.fromDistance ?? -Infinity
  const to = opts.toDistance ?? Infinity
  // Segments are compared in the flat frame centred on p that projectToSegment uses (the same projections), so
  // the loop needs no trigonometry; only the nearest point is then measured on the sphere.
  const kx = Math.cos(toRad(p[1])) * METERS_PER_DEGREE
  const ky = METERS_PER_DEGREE
  let bestI = -1
  let bestT = 0
  let bestD2 = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const segStart = cum[i]!
    const segEnd = cum[i + 1]!
    if (segEnd < from || segStart > to) continue
    const a = coords[i]!
    const b = coords[i + 1]!
    const ax = (a[0] - p[0]) * kx
    const ay = (a[1] - p[1]) * ky
    const dx = (b[0] - p[0]) * kx - ax
    const dy = (b[1] - p[1]) * ky - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    // Clamp the projection into the allowed window when the window cuts this segment.
    const segLen = segEnd - segStart
    const along = segStart + t * segLen
    if (along < from || along > to) t = segLen === 0 ? 0 : (Math.max(from, Math.min(to, along)) - segStart) / segLen
    const x = ax + dx * t
    const y = ay + dy * t
    const d2 = x * x + y * y
    if (d2 < bestD2) {
      bestD2 = d2
      bestI = i
      bestT = t
    }
  }
  if (bestI < 0) return null
  const segStart = cum[bestI]!
  const point = lerp(coords[bestI]!, coords[bestI + 1]!, bestT)
  return { point, segmentIndex: bestI, t: bestT, distanceAlong: segStart + bestT * (cum[bestI + 1]! - segStart), distanceFromLine: haversine(p, point) }
}

/** Point `distanceAlong` meters from the start of the polyline (clamped), with the local heading. */
export function pointAlong(index: PolylineIndex, distanceAlong: number): { point: LngLat; segmentIndex: number; bearing: number } {
  const { coords, cum, total } = index
  if (coords.length === 0) throw new Error('pointAlong: empty polyline')
  if (coords.length === 1) return { point: coords[0]!, segmentIndex: 0, bearing: 0 }
  const d = Math.max(0, Math.min(total, distanceAlong))
  // Binary search for the segment containing d.
  let lo = 0
  let hi = coords.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid]! <= d) lo = mid
    else hi = mid - 1
  }
  const a = coords[lo]!
  const b = coords[lo + 1]!
  const segLen = cum[lo + 1]! - cum[lo]!
  const t = segLen === 0 ? 0 : (d - cum[lo]!) / segLen
  return { point: lerp(a, b, t), segmentIndex: lo, bearing: bearing(a, b) }
}

export function lineLength(coords: LngLat[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1]!, coords[i]!)
  return total
}

export type BBox = [west: number, south: number, east: number, north: number]

export function bboxOf(coords: LngLat[]): BBox | null {
  if (coords.length === 0) return null
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return [w, s, e, n]
}

/** Whether p lies inside bbox expanded by `padMeters` on every side. */
export function bboxContains(bbox: BBox, p: LngLat, padMeters = 0): boolean {
  const [w, s, e, n] = bbox
  const padLat = padMeters / 111_320
  const midLat = (s + n) / 2
  const padLon = padMeters / (111_320 * Math.max(0.01, Math.cos(toRad(midLat))))
  return p[0] >= w - padLon && p[0] <= e + padLon && p[1] >= s - padLat && p[1] <= n + padLat
}

/** Returns the `k` items nearest to `origin` (by haversine), with their distances, ascending. */
export function kNearest<T>(origin: LngLat, items: readonly T[], coordOf: (item: T) => LngLat, k: number, maxDistance = Infinity): Array<{ item: T; distance: number }> {
  const scored: Array<{ item: T; distance: number }> = []
  for (const item of items) {
    const distance = haversine(origin, coordOf(item))
    if (distance <= maxDistance) scored.push({ item, distance })
  }
  scored.sort((a, b) => a.distance - b.distance)
  return scored.slice(0, Math.max(0, k))
}

export function isValidLngLat(p: unknown): p is LngLat {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    p[0] >= -180 &&
    p[0] <= 180 &&
    p[1] >= -90 &&
    p[1] <= 90
  )
}
