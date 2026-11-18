import { describe, expect, it } from 'vitest'
import { buildSavedPlaceFeatures } from './features'

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
