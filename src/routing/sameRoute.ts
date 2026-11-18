// Pure: are two route geometries effectively the same path?
import { buildPolylineIndex, nearestOnPolyline, pointAlong } from '../lib/geo'
import type { LngLat } from '../types'

const SAMPLES = 24

/** True when every sampled point of each route lies within `toleranceMeters` of the other route. */
export function sameRoute(a: readonly LngLat[], b: readonly LngLat[], toleranceMeters: number): boolean {
  if (a.length < 2 || b.length < 2) return false
  const ia = buildPolylineIndex([...a])
  const ib = buildPolylineIndex([...b])
  const covered = (from: typeof ia, to: typeof ib) => {
    for (let i = 0; i <= SAMPLES; i++) {
      const p = pointAlong(from, (from.total * i) / SAMPLES).point
      const snap = nearestOnPolyline(to, p)
      if (!snap || snap.distanceFromLine > toleranceMeters) return false
    }
    return true
  }
  return covered(ia, ib) && covered(ib, ia)
}
