import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import type { LngLat } from '../types'
import { directionsUrl, streetViewUrl, guidePoints, rideLinks, shapingPoints, trailPoints, trailRangesOf, viaPointCount } from './googleMaps'
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

  it('finds every station within reach, also beyond the ends of a long route (the quick box check drops none)', () => {
    const south = MADISON.capitol
    const north = destination(south, 40_000, 0)
    const near = ['east', 'past', 'corner'].map((id, i) => makeStation({ id, coord: destination(north, 249, [90, 0, 45][i]!) }))
    const west = makeStation({ id: 'west', coord: destination(south, 249, 270) })
    const far = [makeStation({ id: 'farEast', coord: destination(north, 252, 90) }), makeStation({ id: 'farPast', coord: destination(north, 252, 0) })]
    const found = stationsAlongRoute([south, north], [...near, west, ...far])
    expect(found.map((s) => s.station.id).sort()).toEqual(['corner', 'east', 'past', 'west'])
    expect(Math.max(...found.map((s) => s.offset))).toBeLessThan(250)
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

describe('Street View link', () => {
  it('opens the panorama at the dock (lat,lon), no API key', () => {
    const u = new URL(streetViewUrl([-89.40804, 43.07214]))
    expect(u.host).toBe('www.google.com')
    expect(Object.fromEntries(u.searchParams)).toEqual({ api: '1', map_action: 'pano', viewpoint: '43.072140,-89.408040' })
  })
})

describe('hand-off styles', () => {
  const at = (m: number): LngLat => destination(A, m, 270)
  const stops = [
    { coord: at(1000), along: 1000, offset: 10, name: 'Dock B' },
    { coord: at(4000), along: 4000, offset: 10, name: 'Dock E' },
  ]
  const trail: Array<[number, number]> = [[1500, 2500]]

  it("'docks' sends only the docks; 'trails' adds a point on the trail; 'exact' one every max gap", () => {
    expect(guidePoints(stops, at, trail, 'docks').map((p) => p.isStop)).toEqual([true, true])
    const trails = guidePoints(stops, at, trail, 'trails')
    expect(trails.map((p) => [p.isStop, p.label ?? null])).toEqual([[true, 'Dock B'], [false, null], [true, 'Dock E']])
    expect(trails[1]!.coord).toEqual(at(2000))
    expect(guidePoints(stops, at, trail, 'exact').filter((p) => !p.isStop).length).toBeGreaterThan(1)
  })

  it('a ride started on a bike: the first link doesn\'t start at a dock', () => {
    expect(rideLinks(A, [B], null, 3, false)[0]!.fromDock).toBe(false)
    expect(rideLinks(A, [B], null)[0]!.fromDock).toBe(true)
  })

  it('one Google link for a Direct ride, even a long one', () => {
    const long = [{ coord: at(9000), along: 9000, offset: 10 }]
    expect(rideLinks(A, guidePoints(long, at, [], 'docks'), null)).toHaveLength(1)
    expect(rideLinks(A, guidePoints(long, at, [], 'exact'), null).length).toBeGreaterThan(1)
  })
})

describe('trail points', () => {
  const at = (m: number): LngLat => destination(A, m, 270)
  const alongs = (stopAlongs: number[], end: number, ranges: Array<[number, number]>, slots = 12) => trailPoints(stopAlongs, end, slots, at, ranges).map((p) => p.along)

  it('puts one point mid-section, more on a long one, none on a short one', () => {
    expect(alongs([], 6000, [[1000, 2000]])).toEqual([1500])
    expect(alongs([], 6000, [[1000, 1300]])).toEqual([]) // shorter than trailMinMeters
    // 4 km of trail: two points, evenly spread.
    expect(alongs([], 9000, [[1000, 5000]])).toEqual([2000, 4000])
  })

  it('joins sections split by a street crossing, drops points next to a dock, and ends at the end dock', () => {
    expect(alongs([], 6000, [[1000, 1300], [1350, 1600]])).toEqual([1300])
    expect(alongs([1450], 6000, [[1000, 2000]])).toEqual([]) // the dock at 1450 anchors it
    expect(alongs([], 1600, [[1000, 1500]])).toEqual([1250])
    // Cut at the end dock.
    expect(alongs([], 2000, [[1000, 4000]])).toEqual([1500])
  })

  it('stops at the slot limit', () => {
    expect(alongs([], 20000, [[1000, 2000], [5000, 6000], [9000, 10000]], 2)).toEqual([1500, 5500])
  })

  it('counts a route\'s waypoints for its card', () => {
    const geometry = [at(0), at(1000), at(2000), at(3000)]
    const maneuvers = [
      { kind: 'depart', streetNames: ['Regent Street'], beginIndex: 0, endIndex: 1 },
      { kind: 'turn', streetNames: ['Southwest Path'], beginIndex: 1, endIndex: 2 },
      { kind: 'turn', streetNames: ['Elm Street'], beginIndex: 2, endIndex: 3 },
    ] as never
    expect(viaPointCount({ geometry, maneuvers }, 'docks')).toBe(0)
    expect(viaPointCount({ geometry, maneuvers }, 'trails')).toBe(1)
    expect(viaPointCount({ geometry, maneuvers }, 'exact')).toBeGreaterThan(1)
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
