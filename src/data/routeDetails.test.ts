import { describe, expect, it } from 'vitest'
import { ROUTE_DETAILS } from '../config'
import { destination } from '../lib/geo'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import { MADISON } from '../test/factories'
import type { LngLat } from '../types'
import { detailsPolyline, thinRoute } from './routeDetails'

describe('thinRoute', () => {
  it('keeps the ends and drops points closer than the minimum spacing', () => {
    const pts: LngLat[] = Array.from({ length: 101 }, (_, i) => destination(MADISON.capitol, i * 2, 90)) // every 2 m over 200 m
    const thin = thinRoute(pts, 8)
    expect(thin[0]).toEqual(pts[0])
    expect(thin.at(-1)).toEqual(pts.at(-1))
    expect(thin.length).toBeLessThanOrEqual(27)
    expect(thinRoute(pts.slice(0, 2), 8)).toHaveLength(2)
  })
})

describe('detailsPolyline', () => {
  it('sends a normal route thinned at the usual spacing', () => {
    const pts: LngLat[] = Array.from({ length: 300 }, (_, i) => destination(MADISON.capitol, i * 10, 90))
    expect(detailsPolyline(pts)).toBe(encodePolyline(thinRoute(pts), 6))
  })

  it('thins a long route further until it fits what the server accepts', () => {
    // ~70 km zigzagging every 10 m: far more points than the server takes at the usual spacing.
    const pts: LngLat[] = []
    let p = MADISON.capitol
    for (let i = 0; i < 7_000; i++) {
      pts.push(p)
      p = destination(p, 10, i % 2 ? 80 : 100)
    }
    expect(thinRoute(pts).length).toBeGreaterThan(ROUTE_DETAILS.maxPoints)
    const encoded = detailsPolyline(pts)
    const decoded = decodePolyline(encoded, 6)
    expect(encoded.length).toBeLessThanOrEqual(ROUTE_DETAILS.maxPolylineChars)
    expect(decoded.length).toBeLessThanOrEqual(ROUTE_DETAILS.maxPoints)
    expect(decoded.length).toBeGreaterThan(1000) // still a usable trace
    expect(decoded[0]![0]).toBeCloseTo(pts[0]![0], 5)
    expect(decoded.at(-1)![1]).toBeCloseTo(pts.at(-1)![1], 5)
  })
})
