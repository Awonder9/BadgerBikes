import { describe, expect, it } from 'vitest'
import trace from '../test/fixtures/valhalla/trace_attributes_bicycle.json'
import { classifyEdge, normalizeTraceAttributes } from './details'

describe('route details (trace_attributes)', () => {
  it('classifies ways from most to least separated from traffic', () => {
    expect(classifyEdge({ use: 'cycleway' })).toBe('bikePath')
    expect(classifyEdge({ use: 'footway' })).toBe('sharedPath')
    expect(classifyEdge({ use: 'road', cycle_lane: 'separated', road_class: 'primary' })).toBe('protectedLane')
    expect(classifyEdge({ use: 'road', cycle_lane: 'dedicated', road_class: 'secondary' })).toBe('bikeLane')
    expect(classifyEdge({ use: 'road', cycle_lane: 'shared', road_class: 'residential' })).toBe('sharedLane')
    expect(classifyEdge({ use: 'road', cycle_lane: 'none', road_class: 'residential' })).toBe('quietStreet')
    expect(classifyEdge({ use: 'road', cycle_lane: 'none', road_class: 'primary' })).toBe('busyRoad')
    expect(classifyEdge({ use: 'parking_aisle', cycle_lane: 'none', road_class: 'service_other' })).toBe('quietStreet')
  })

  it('sums meters per kind and summarizes elevation from a real response', () => {
    const d = normalizeTraceAttributes(trace)
    const total = d.breakdown.reduce((s, b) => s + b.meters, 0)
    expect(total).toBeGreaterThan(1500)
    expect(d.breakdown[0]!.meters).toBeGreaterThanOrEqual(d.breakdown.at(-1)!.meters) // largest first
    expect(d.elevation).not.toBeNull()
    expect(d.elevation!.maxM).toBeGreaterThanOrEqual(d.elevation!.minM)
    expect(d.elevation!.gainM).toBeGreaterThanOrEqual(0)
    expect(d.elevation!.profile.length).toBeGreaterThan(10)
    // Colored stretches: consecutive, each of one kind, neighbours of the same kind merged.
    expect(d.segments.length).toBeGreaterThan(1)
    expect(d.segments.every((s) => s.coords.length >= 2)).toBe(true)
    const pairs = d.segments.slice(1).map((s, i) => [d.segments[i]!, s] as const)
    expect(pairs.every(([a, b]) => a.kind !== b.kind)).toBe(true)
    expect(pairs.every(([a, b]) => JSON.stringify(a.coords.at(-1)) === JSON.stringify(b.coords[0]))).toBe(true) // no gaps
  })

  it('ignores elevation noise and missing data', () => {
    const edges = (eles: number[]) => ({ units: 'kilometers', edges: eles.map((e) => ({ length: 0.1, use: 'road', cycle_lane: 'none', road_class: 'residential', mean_elevation: e })) })
    expect(normalizeTraceAttributes(edges([270, 271, 272, 271, 270])).elevation).toMatchObject({ gainM: 0, lossM: 0 })
    expect(normalizeTraceAttributes(edges([270, 280, 290, 285, 275])).elevation).toMatchObject({ gainM: 20, lossM: 15 })
    expect(normalizeTraceAttributes(edges([-32768, -32768])).elevation).toBeNull()
    expect(normalizeTraceAttributes(edges([270, 280])).segments).toEqual([]) // no shape → no colored line
    expect(() => normalizeTraceAttributes({})).toThrow('no edges')
  })
})
