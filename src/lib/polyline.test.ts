import { describe, expect, it } from 'vitest'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import type { LngLat } from '../types'
import { haversine } from './geo'
import { decodePolyline, encodePolyline } from './polyline'

describe('polyline', () => {
  it('decodes the canonical Google example at precision 5', () => {
    // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    const coords = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)
    expect(coords).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ])
  })

  it('round-trips at precision 6', () => {
    const coords: LngLat[] = [
      [-89.38527, 43.07571],
      [-89.400053, 43.077021],
      [-89.399551, 43.074871],
    ]
    expect(decodePolyline(encodePolyline(coords, 6), 6)).toEqual(coords)
  })

  it('decodes a real Valhalla shape into plausible Madison coordinates', () => {
    const shape = valhallaBike.trip.legs[0]!.shape
    const coords = decodePolyline(shape, 6)
    expect(coords.length).toBeGreaterThan(10)
    for (const [lon, lat] of coords) {
      expect(lon).toBeGreaterThan(-89.5)
      expect(lon).toBeLessThan(-89.3)
      expect(lat).toBeGreaterThan(43.0)
      expect(lat).toBeLessThan(43.15)
    }
    // Starts near the first location Valhalla echoed back.
    const loc = valhallaBike.trip.locations[0]!
    expect(haversine(coords[0]!, [loc.lon, loc.lat])).toBeLessThan(50)
  })

  it('stops cleanly on truncated input', () => {
    const full = encodePolyline([[-89.4, 43.07], [-89.39, 43.08]], 6)
    expect(decodePolyline(full.slice(0, full.length - 2), 6).length).toBe(1)
    expect(decodePolyline('', 6)).toEqual([])
  })
})
