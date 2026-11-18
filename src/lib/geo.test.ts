import { describe, expect, it } from 'vitest'
import type { LngLat } from '../types'
import {
  bboxContains,
  bboxOf,
  bearing,
  bearingDelta,
  buildPolylineIndex,
  destination,
  haversine,
  isValidLngLat,
  kNearest,
  lineLength,
  nearestOnPolyline,
  pointAlong,
  projectToSegment,
} from './geo'

const capitol: LngLat = [-89.3842, 43.07467]
const memorialUnion: LngLat = [-89.4003, 43.07652]

describe('haversine / bearing / destination', () => {
  it('matches known distances', () => {
    // Capitol → Memorial Union is ~1.32 km as the crow flies.
    expect(haversine(capitol, memorialUnion)).toBeGreaterThan(1300)
    expect(haversine(capitol, memorialUnion)).toBeLessThan(1340)
    expect(haversine(capitol, capitol)).toBe(0)
  })

  it('computes bearings in [0, 360)', () => {
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(0, 5)
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90, 5)
    expect(bearing([0, 0], [0, -1])).toBeCloseTo(180, 5)
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(270, 5)
    expect(bearingDelta(350, 10)).toBe(20)
    expect(bearingDelta(90, 270)).toBe(180)
  })

  it('round-trips destination and haversine', () => {
    const p = destination(capitol, 500, 45)
    expect(haversine(capitol, p)).toBeCloseTo(500, 3)
    expect(bearing(capitol, p)).toBeCloseTo(45, 1)
  })
})

describe('projectToSegment', () => {
  it('clamps to the segment ends and finds interior projections', () => {
    const a: LngLat = [-89.4, 43.07]
    const b: LngLat = [-89.39, 43.07]
    const before = projectToSegment([-89.41, 43.07], a, b)
    expect(before.t).toBe(0)
    const mid = projectToSegment([-89.395, 43.071], a, b)
    expect(mid.t).toBeCloseTo(0.5, 2)
    expect(mid.distance).toBeCloseTo(111.2, 0) // 0.001° of latitude
  })

  it('handles degenerate segments', () => {
    const a: LngLat = [-89.4, 43.07]
    const r = projectToSegment([-89.4, 43.071], a, a)
    expect(r.t).toBe(0)
    expect(r.point).toEqual(a)
  })
})

describe('polyline index', () => {
  // An L-shaped route: 1 km east then 1 km north.
  const start: LngLat = [-89.4, 43.07]
  const corner = destination(start, 1000, 90)
  const end = destination(corner, 1000, 0)
  const index = buildPolylineIndex([start, corner, end])

  it('accumulates distances', () => {
    expect(index.total).toBeCloseTo(2000, 0)
    expect(index.cum[1]).toBeCloseTo(1000, 0)
    expect(lineLength([start, corner, end])).toBeCloseTo(2000, 0)
  })

  it('snaps to the nearest point and reports progress', () => {
    const p = destination(destination(start, 400, 90), 20, 0) // 400 m along, 20 m off
    const snap = nearestOnPolyline(index, p)!
    expect(snap.segmentIndex).toBe(0)
    expect(snap.distanceAlong).toBeCloseTo(400, 0)
    expect(snap.distanceFromLine).toBeCloseTo(20, 0)
  })

  it('restricts the search window for forward-only snapping', () => {
    // A point near the corner is equally close to both segments; force the second segment.
    const nearCorner = destination(corner, 30, 225)
    const windowed = nearestOnPolyline(index, nearCorner, { fromDistance: 1100 })!
    expect(windowed.segmentIndex).toBe(1)
    expect(windowed.distanceAlong).toBeGreaterThanOrEqual(1100 - 1e-6)
  })

  it('interpolates points along the line', () => {
    const half = pointAlong(index, 1500)
    expect(half.segmentIndex).toBe(1)
    expect(haversine(half.point, destination(corner, 500, 0))).toBeLessThan(0.5)
    expect(half.bearing).toBeCloseTo(0, 0)
    expect(pointAlong(index, -10).point).toEqual(start)
    expect(haversine(pointAlong(index, 99_999).point, end)).toBeLessThan(0.01)
  })

  it('handles empty and single-point lines', () => {
    expect(nearestOnPolyline(buildPolylineIndex([]), start)).toBeNull()
    const single = nearestOnPolyline(buildPolylineIndex([start]), corner)!
    expect(single.distanceFromLine).toBeCloseTo(1000, 0)
  })
})

describe('bbox / kNearest / validation', () => {
  it('computes and tests bboxes with padding', () => {
    const bb = bboxOf([capitol, memorialUnion])!
    expect(bb).toEqual([-89.4003, 43.07467, -89.3842, 43.07652])
    expect(bboxContains(bb, [-89.39, 43.075])).toBe(true)
    const outside = destination(memorialUnion, 500, 270)
    expect(bboxContains(bb, outside)).toBe(false)
    expect(bboxContains(bb, outside, 600)).toBe(true)
    expect(bboxOf([])).toBeNull()
  })

  it('returns the k nearest items within range', () => {
    const items = [
      { id: 'far', c: destination(capitol, 900, 0) },
      { id: 'near', c: destination(capitol, 100, 0) },
      { id: 'mid', c: destination(capitol, 400, 0) },
    ]
    const r = kNearest(capitol, items, (i) => i.c, 2)
    expect(r.map((x) => x.item.id)).toEqual(['near', 'mid'])
    expect(kNearest(capitol, items, (i) => i.c, 5, 500).map((x) => x.item.id)).toEqual(['near', 'mid'])
  })

  it('validates coordinates', () => {
    expect(isValidLngLat(capitol)).toBe(true)
    expect(isValidLngLat([200, 0])).toBe(false)
    expect(isValidLngLat([0, Number.NaN])).toBe(false)
    expect(isValidLngLat('x')).toBe(false)
  })
})
