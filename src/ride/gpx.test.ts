import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON } from '../test/factories'
import type { LngLat } from '../types'
import { gpxFileName, rideGpx, sliceRoute, xmlEscape } from './gpx'

const A = MADISON.capitol
const at = (m: number): LngLat => destination(A, m, 90)
const route = [A, at(1000), at(2000), at(3000)]

describe('GPX export', () => {
  it('escapes XML (station names contain &)', () => {
    expect(xmlEscape(`Park & "Spring" <St>'`)).toBe('Park &amp; &quot;Spring&quot; &lt;St&gt;&apos;')
  })

  it('cuts the track where the ride ends', () => {
    const cut = sliceRoute(route, 1500)
    expect(cut).toHaveLength(3)
    expect(cut[2]![0]).toBeCloseTo(at(1500)[0], 6)
    expect(sliceRoute(route, 99_999)).toHaveLength(4)
  })

  it('writes the ride as one track to the end dock, with waypoints for the start, docks and destination', () => {
    const gpx = rideGpx({
      name: 'Bike ride to Cafe & Bar',
      route,
      start: { name: 'S. Breese @ Camp Randall', coord: A },
      stops: [
        { name: 'Park & Spring', coord: at(1000), along: 1000 },
        { name: 'W. Wilson & MLK', coord: destination(at(2000), 120, 0), along: 2000 }, // 120 m off the line
      ],
      destination: { name: 'Cafe & Bar', coord: at(3000) },
      timeIso: '2026-11-18T12:00:00.000Z',
    })
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(gpx).toContain('<name>Dock: Park &amp; Spring</name>')
    expect(gpx).toContain('<name>Dock here: W. Wilson &amp; MLK</name>')
    expect(gpx).toContain('<name>Destination: Cafe &amp; Bar</name>')
    expect(gpx).not.toMatch(/& /) // nothing unescaped
    // Track: A, at(1000), the point at 2000 m, then the off-line end dock itself.
    expect(gpx.match(/<trkpt /g)).toHaveLength(4)
    expect(gpx.match(/<wpt /g)).toHaveLength(4)
  })

  it('makes a portable file name', () => {
    expect(gpxFileName('Café CODA & Friends')).toBe('bike-ride-to-cafe-coda-friends.gpx')
    expect(gpxFileName(null)).toBe('bike-ride-to-ride.gpx')
    expect(gpxFileName('???')).toBe('bike-ride-to-destination.gpx')
  })
})
