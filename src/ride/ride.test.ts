import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import type { LngLat } from '../types'
import { directionsUrl, guidePoints, rideLinks, shapingPoints, trailRangesOf } from './googleMaps'
import { rideSegments, stationsAlongRoute } from './stationsAlongRoute'

const A = MADISON.capitol
const B = destination(A, 3000, 270)
const route: LngLat[] = [A, destination(A, 1500, 270), B]

describe('stationsAlongRoute', () => {
  const st = (id: string, along: number, off: number, o: Parameters<typeof makeStation>[0] = {}) =>
    makeStation({ id, name: id, coord: destination(destination(A, along, 270), off, 0), ...o })
  const stations = [st('far', 1000, 600), st('mid', 1400, 100), st('early', 300, 50), st('end', 2900, 80, { docks: 1 }), st('end2', 2700, 60, { docks: 6 }), st('start', 0, 0), st('off', 800, 20, { isInstalled: false })]

  it('keeps stations near the route in order, skipping excluded and uninstalled', () => {
    const r = stationsAlongRoute(route, stations, new Set(['start']))
    expect(r.map((s) => s.station.id)).toEqual(['early', 'mid', 'end2', 'end'])
    expect(r[0]!.offset).toBeCloseTo(50, 0)
  })

  it('flags segments longer than the included ride time', () => {
    const r = stationsAlongRoute(route, stations, new Set(['start']))
    const segs = rideSegments('start', [r[1]!, r[2]!], 3)
    expect(segs.map((s) => s.toId)).toEqual(['mid', 'end2'])
    expect(segs[0]!.overIncluded).toBe(true) // 1.4 km at 14 km/h ≈ 6 min > 3
  })
})

describe('google maps links', () => {
  it('builds a bicycling link with waypoints', () => {
    const url = new URL(directionsUrl(A, B, 'bicycling', [route[1]!]))
    expect(url.hostname).toBe('www.google.com')
    expect(url.searchParams.get('travelmode')).toBe('bicycling')
    expect(url.searchParams.get('origin')).toBe('43.074670,-89.384200')
    expect(url.searchParams.get('waypoints')?.split('|')).toHaveLength(1)
  })

  it('splits long rides into ≤3-waypoint links and adds the walk', () => {
    const stops = Array.from({ length: 6 }, (_, i) => destination(A, (i + 1) * 400, 270))
    const links = rideLinks(A, stops, B)
    expect(links.map((l) => l.label)).toEqual(['Ride part 1 of 2', 'Ride part 2 of 2', 'Walk to destination'])
    const first = new URL(links[0]!.url)
    expect(first.searchParams.get('waypoints')!.split('|')).toHaveLength(3)
    // Part 2 starts where part 1 ended.
    expect(new URL(links[1]!.url).searchParams.get('origin')).toBe(first.searchParams.get('destination'))
    expect(new URL(links[2]!.url).searchParams.get('travelmode')).toBe('walking')
    expect(rideLinks(A, [B], null).map((l) => l.label)).toEqual(['Ride'])
  })
})

describe('guide points', () => {
  const at = (m: number): LngLat => destination(A, m, 270)
  it('splits until no stretch exceeds the max gap', () => {
    const vias = shapingPoints([], 3000, 12, at, [], 700)
    const marks = [0, ...vias.map((p) => p.along), 3000]
    expect(marks.slice(1).every((m, i) => m - marks[i]! <= 700)).toBe(true)
    expect(vias.length).toBeLessThanOrEqual(4)
  })

  it('sends on-route docks as the point on the line, keeps the end dock and off-route docks as is', () => {
    const offLine = destination(at(1000), 40, 0)
    const farDock = destination(at(1500), 200, 0)
    const end = destination(at(2000), 30, 0)
    const pts = guidePoints(
      [
        { coord: offLine, along: 1000, offset: 40 },
        { coord: farDock, along: 1500, offset: 200 },
        { coord: end, along: 2000, offset: 30 },
      ],
      at,
    )
    expect(pts.filter((p) => p.isStop).map((p) => p.coord)).toEqual([at(1000), farDock, end])
    expect(pts.at(-1)).toEqual({ coord: end, isStop: true })
    // 0–1000 is longer than the max gap → one via point before the first dock.
    expect(pts[0]!.isStop).toBe(false)
  })

  it('labels where each part ends and whether it starts at a dock', () => {
    const P = (m: number, isStop: boolean, label?: string) => ({ coord: at(m), isStop, ...(label ? { label } : {}) })
    const links = rideLinks(A, [P(500, false), P(1000, true, 'Dock B'), P(1500, false), P(2000, false), P(2500, false), P(3000, true, 'Dock E')], B)
    expect(links.map((l) => [l.kind, l.endLabel, l.fromDock])).toEqual([
      ['ride', 'Dock B', true],
      ['ride', 'Dock E', true],
      ['walk', null, false],
    ])
  })

  it('ends links at dock stops rather than at via points', () => {
    const P = (m: number, isStop: boolean) => ({ coord: at(m), isStop })
    // start, via, stop, via, via, via, end → first link ends at the stop (index 2), not at the 4th point.
    const links = rideLinks(A, [P(500, false), P(1000, true), P(1500, false), P(2000, false), P(2500, false), P(3000, true)], null)
    expect(links).toHaveLength(2)
    expect(new URL(links[0]!.url).searchParams.get('destination')).toBe(new URL(directionsUrl(at(1000), at(1000), 'walking')).searchParams.get('origin'))
  })
})

describe('shaping points', () => {
  const at = (m: number): LngLat => destination(A, m, 270)
  it('uses the fewest via points so no stretch exceeds the max gap', () => {
    expect(shapingPoints([], 500, 3, at, [], 800)).toEqual([]) // too short to matter
    expect(shapingPoints([], 6000, 0, at, [], 800)).toEqual([])
    expect(shapingPoints([], 1600, 5, at, [], 800).map((p) => p.along)).toEqual([800])
    expect(shapingPoints([], 2400, 5, at, [], 800).map((p) => p.along)).toEqual([800, 1600])
    // A stop at 700 already guides 0–700; only 700–2000 needs a point.
    expect(shapingPoints([700], 2000, 5, at, [], 800).map((p) => p.along)).toEqual([1350])
    // Out of slots: stop early.
    expect(shapingPoints([], 8000, 2, at, [], 800)).toHaveLength(2)
  })

  it('puts via points on trail sections, where Google tends to switch to a parallel road', () => {
    // 0–1200 needs one point somewhere in [400, 800]; a trail at 600–2000 pulls it to 700.
    expect(shapingPoints([], 1200, 5, at, [[600, 2000]], 800).map((p) => p.along)).toEqual([700])
    // A sliver of trail inside the window (750–800) is ignored.
    expect(shapingPoints([], 1200, 5, at, [[750, 2000]], 800).map((p) => p.along)).toEqual([600])
    // A trail outside the allowed window doesn't.
    expect(shapingPoints([], 1200, 5, at, [[900, 2000]], 800).map((p) => p.along)).toEqual([600])
    const cum = [0, 100, 600, 900]
    const ranges = trailRangesOf(
      [
        { streetNames: ['Regent Street'], beginIndex: 0, endIndex: 1 },
        { streetNames: ['Southwest Path'], beginIndex: 1, endIndex: 2 },
        { beginIndex: 2, endIndex: 3, instruction: 'Turn right onto Elm Street.' },
      ],
      cum,
    )
    expect(ranges).toEqual([[100, 600]])
    expect(trailRangesOf([{ beginIndex: 0, endIndex: 2, instruction: 'Turn left onto the cycleway.' }], cum)).toEqual([[0, 600]])
  })
})
