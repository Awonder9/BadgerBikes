import { describe, expect, it } from 'vitest'
import { LOOP } from '../config'
import { bearing, bearingDelta, destination, haversine } from '../lib/geo'
import type { LngLat } from '../types'
import { loopTargetMeters, planLoop, seededRandom } from './loop'
import { parseScenic, routeHighlights, type ScenicPoint } from './scenic'
import madison from '../data/scenic/bcycle_madison.json'

const start: LngLat = [-89.3838, 43.0748] // Madison, the Capitol
const scenic = parseScenic(madison)

/** Straight-line length start → via… → end. */
const straightLength = (from: LngLat, via: LngLat[], to: LngLat) => [from, ...via, to].reduce((sum, c, i, all) => (i ? sum + haversine(all[i - 1]!, c) : 0), 0)

describe('seededRandom', () => {
  it('repeats for a seed and differs between seeds', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    const c = seededRandom(8)
    const xs = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(xs)
    expect(c()).not.toBe(xs[0])
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('planLoop', () => {
  const target = loopTargetMeters(30, 14) // 7 km

  it('a loop back to the start: two scenic trail points, about the wanted size', () => {
    const plan = planLoop({ start, targetMeters: target, roundTrip: true, seed: 1, points: scenic, endDocks: [] })
    expect(plan.end).toBeNull()
    expect(plan.fellBackToRoundTrip).toBe(false)
    expect(plan.via).toHaveLength(2)
    expect(plan.via.every((v) => !v.synthetic)).toBe(true)
    const len = straightLength(start, plan.via.map((v) => v.coord), start)
    expect(Math.abs(len - target / LOOP.detourFactor) / (target / LOOP.detourFactor)).toBeLessThan(0.35)
    // A triangle, not out and back along one line.
    const spread = bearingDelta(bearing(start, plan.via[0]!.coord), bearing(start, plan.via[1]!.coord))
    expect(spread).toBeGreaterThanOrEqual(30)
  })

  it('is repeatable for a seed, and another seed can pick another ride', () => {
    const one = planLoop({ start, targetMeters: target, roundTrip: true, seed: 42, points: scenic, endDocks: [] })
    expect(planLoop({ start, targetMeters: target, roundTrip: true, seed: 42, points: scenic, endDocks: [] })).toEqual(one)
    const others = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(planLoop({ start, targetMeters: target, roundTrip: true, seed, points: scenic, endDocks: [] }).via))
    expect(new Set(others).size).toBeGreaterThan(1)
  })

  it('prefers scenic points: the waypoints score above the average trail point', () => {
    const avg = scenic.reduce((s, p) => s + p.score, 0) / scenic.length
    const plan = planLoop({ start, targetMeters: target, roundTrip: true, seed: 3, points: scenic, endDocks: [] })
    const scores = plan.via.map((v) => scenic.find((p) => p.coord === v.coord)!.score)
    expect(scores.reduce((a, b) => a + b, 0) / scores.length).toBeGreaterThan(avg)
  })

  it('without scenery: an equilateral triangle of synthesized points', () => {
    const plan = planLoop({ start, targetMeters: target, roundTrip: true, seed: 9, points: [], endDocks: [] })
    expect(plan.via.map((v) => v.synthetic)).toEqual([true, true])
    const side = target / LOOP.detourFactor / 3
    for (const v of plan.via) expect(haversine(start, v.coord)).toBeCloseTo(side, -1)
  })

  it('one way: ends at a dock well away from the start, through a scenic point toward it', () => {
    const far = destination(start, 3_000, 45)
    const tooNear = destination(start, 300, 200)
    const plan = planLoop({ start, targetMeters: target, roundTrip: false, seed: 5, points: scenic, endDocks: [{ id: 'near', coord: tooNear }, { id: 'far', coord: far }] })
    expect(plan.end?.id).toBe('far')
    expect(plan.fellBackToRoundTrip).toBe(false)
    expect(plan.via).toHaveLength(1)
    const len = straightLength(start, plan.via.map((v) => v.coord), far)
    expect(Math.abs(len - target / LOOP.detourFactor) / (target / LOOP.detourFactor)).toBeLessThan(0.35)
  })

  it('one way with no dock in range comes back to the start instead (and says so)', () => {
    const plan = planLoop({ start, targetMeters: target, roundTrip: false, seed: 5, points: scenic, endDocks: [{ id: 'x', coord: destination(start, 100, 0) }] })
    expect(plan.end).toBeNull()
    expect(plan.fellBackToRoundTrip).toBe(true)
    expect(plan.via).toHaveLength(2)
  })

  it('one way without scenery bows out to one side so the ride is about the wanted length', () => {
    const end = destination(start, 2_500, 90)
    const plan = planLoop({ start, targetMeters: target, roundTrip: false, seed: 2, points: [], endDocks: [{ id: 'e', coord: end }] })
    expect(plan.via).toHaveLength(1)
    expect(plan.via[0]!.synthetic).toBe(true)
    expect(straightLength(start, [plan.via[0]!.coord], end)).toBeCloseTo(target / LOOP.detourFactor, -2)
  })

  it('a rescaled plan (after a route came out too long) is smaller', () => {
    const big = planLoop({ start, targetMeters: target, roundTrip: true, seed: 11, points: [], endDocks: [] })
    const small = planLoop({ start, targetMeters: target, roundTrip: true, seed: 11, points: [], endDocks: [], scale: 0.6 })
    expect(haversine(start, small.via[0]!.coord)).toBeLessThan(haversine(start, big.via[0]!.coord))
  })
})

describe('scenic data', () => {
  it('parses the generated file and skips malformed points', () => {
    expect(scenic.length).toBeGreaterThan(100)
    expect(scenic.every((p) => p.score >= 1)).toBe(true)
    expect(parseScenic(null)).toEqual([])
    expect(parseScenic({ v: 2, points: [], places: [], trails: [] })).toEqual([])
    const parsed = parseScenic({ v: 1, places: [['Tenney Park', 'p'], ['viewpoint', 'v']], trails: ['Yahara River Path'], points: [[-89.37, 43.09, 5, 0, 0], [-89.36, 43.08, 4, -1, 1], [500, 43, 1, -1, -1], 'x'] })
    expect(parsed).toEqual([
      { coord: [-89.37, 43.09], score: 5, trail: 'Yahara River Path', place: { kind: 'park', name: 'Tenney Park' } },
      // An unnamed viewpoint has no name (the UI says "a scenic viewpoint").
      { coord: [-89.36, 43.08], score: 4, trail: null, place: { kind: 'viewpoint', name: '' } },
    ])
  })

  it('lists the places and trails a line passes, most notable first chosen, in ride order', () => {
    const pts: ScenicPoint[] = [
      { coord: [-89.4, 43.0], score: 3, trail: 'Lakeshore Path', place: { kind: 'water', name: 'Lake Mendota' } },
      { coord: [-89.39, 43.0], score: 3, trail: 'Lakeshore Path', place: null },
      { coord: [-89.38, 43.0005], score: 4, trail: null, place: { kind: 'viewpoint', name: 'Picnic Point' } },
      { coord: [-89.39, 43.05], score: 9, trail: 'Far Trail', place: { kind: 'park', name: 'Far Park' } }, // 5 km off the line
    ]
    const line: LngLat[] = [[-89.41, 43.0], [-89.37, 43.0]]
    expect(routeHighlights(line, pts, 120, 5)).toEqual([
      { kind: 'water', name: 'Lake Mendota' },
      { kind: 'trail', name: 'Lakeshore Path' },
      { kind: 'viewpoint', name: 'Picnic Point' },
    ])
    expect(routeHighlights(line, pts, 120, 1)).toEqual([{ kind: 'viewpoint', name: 'Picnic Point' }])
    expect(routeHighlights([[-89.41, 43.0]], pts, 120, 5)).toEqual([])
  })
})
