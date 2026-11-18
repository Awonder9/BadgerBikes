import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON } from '../test/factories'
import type { LngLat } from '../types'
import { thinRoute } from './routeDetails'

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
