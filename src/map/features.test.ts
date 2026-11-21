import { describe, expect, it } from 'vitest'
import { makeSnapshot, makeStation } from '../test/factories'
import { destination, lineLength } from '../lib/geo'
import { buildSavedPlaceFeatures, buildStationFeatures, clipSegments } from './features'

describe('clipSegments', () => {
  it('keeps the colored segments only up to the end dock', () => {
    const at = (m: number) => destination([-89.4, 43.07], m, 90)
    const segs = [
      { kind: 'bikePath', coords: [at(0), at(1000)] },
      { kind: 'bikeLane', coords: [at(1000), at(2000)] },
      { kind: 'road', coords: [at(2000), at(3000)] },
    ]
    const cut = clipSegments(segs, 1500)
    expect(cut.map((s) => s.kind)).toEqual(['bikePath', 'bikeLane'])
    expect(lineLength(cut[1]!.coords)).toBeCloseTo(500, 0)
    expect(clipSegments(segs, 99_999)).toEqual(segs)
  })
})

describe('buildSavedPlaceFeatures', () => {
  it('keeps only this city’s saved places, with their id and icon', () => {
    const saved = [
      { id: 'h', systemId: 'bcycle_madison', icon: 'home' as const, place: { coord: [-89.4, 43.07] as [number, number] } },
      { id: 'f', systemId: 'bcycle_madison', icon: 'star' as const, place: { coord: [-89.38, 43.07] as [number, number] } },
      { id: 'w', systemId: 'bcycle_indego', icon: 'work' as const, place: { coord: [-75.16, 39.95] as [number, number] } },
    ]
    const fc = buildSavedPlaceFeatures(saved, 'bcycle_madison')
    expect(fc.features.map((f) => f.properties)).toEqual([
      { id: 'h', icon: 'home' },
      { id: 'f', icon: 'star' },
    ])
    expect(fc.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [-89.4, 43.07] })
    expect(buildSavedPlaceFeatures(saved, null).features).toEqual([])
  })
})

describe('buildStationFeatures', () => {
  it('carries e-bike availability for "Prefer e-bikes", falling back to all bikes without a breakdown', () => {
    const mixed = makeStation({ id: 'm', bikes: 5, ebikes: 0, classic: 5 })
    const untyped = makeStation({ id: 'u', bikes: 5, ebikes: null })
    const fc = buildStationFeatures(makeSnapshot([mixed, untyped]), { partySize: 1, starred: new Set(), roles: new Map() })
    expect(fc.features.map((f) => [f.properties.id, f.properties.bikeState, f.properties.ebikeState, f.properties.ebikes])).toEqual([
      ['m', 'ok', 'none', 0],
      ['u', 'ok', 'ok', -1],
    ])
  })
})
