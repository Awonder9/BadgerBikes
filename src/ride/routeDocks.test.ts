import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import type { LngLat } from '../types'
import { optimizedStops, routeDocks } from './stationsAlongRoute'

const A = MADISON.capitol
const along = (m: number, off = 0): LngLat => destination(destination(A, m, 270), off, 0)
const st = (id: string, m: number, off: number, o: Parameters<typeof makeStation>[0] = {}) => makeStation({ id, name: id, coord: along(m, off), ...o })

describe('routeDocks (strict)', () => {
  const B = along(3000)
  const route: LngLat[] = [A, B]

  it('keeps only docks on the line; nearby-but-off-line docks are dropped', () => {
    const r = routeDocks(route, [st('on1', 1000, 20), st('vicinity', 1500, 200), st('on2', 2950, 30), st('nearDestOff', 3000, 250)], { destination: B })
    expect(r.map((d) => [d.station.id, d.reason])).toEqual([
      ['on1', 'onRoute'],
      ['on2', 'onRoute'],
    ])
  })

  it('adds the latest off-route re-dock before 25 minutes when no on-line dock covers it', () => {
    // 14 km/h → 25 min ≈ 5.8 km. Route 9 km, only on-line dock at 8.5 km.
    const C = along(9000)
    const r = routeDocks([A, C], [st('late', 8500, 10), st('offEarly', 2000, 150), st('offLate', 5500, 200), st('tooFar', 5600, 400)], { destination: C })
    expect(r.map((d) => [d.station.id, d.reason])).toEqual([
      ['offLate', 'redock'],
      ['late', 'onRoute'],
    ])
  })

  it('adds the dock nearest the destination only when the last on-line dock is a long walk away', () => {
    const r = routeDocks(route, [st('onEarly', 1500, 10), st('byDest', 3000, 300), st('byDest2', 2900, 350)], { destination: B })
    expect(r.map((d) => [d.station.id, d.reason])).toEqual([
      ['onEarly', 'onRoute'],
      ['byDest', 'nearDestination'],
    ])
  })

  it('always includes a destination dock the rider chose', () => {
    const r = routeDocks(route, [st('dest', 3000, 45), st('full', 1200, 5, { docks: 0 })], { destination: B, destStationId: 'dest' })
    expect(r.map((d) => d.station.id)).toEqual(['full', 'dest'])
    expect(optimizedStops(r, { destination: B, destStationId: 'dest' })).toEqual(['dest'])
  })

  it('keeps the docks the rider chose when their counts change: a full end dock stays the end, with an alternative', () => {
    // byDest was the end dock near the destination; it filled up mid-ride.
    const stations = [st('onEarly', 1500, 10), st('byDest', 3000, 300, { docks: 0 }), st('byDest2', 2900, 350)]
    expect(routeDocks(route, stations, { destination: B }).map((d) => d.station.id)).toEqual(['onEarly', 'byDest2']) // what a new plan offers
    const kept = routeDocks(route, stations, { destination: B, keepIds: ['byDest'] })
    expect(kept.map((d) => [d.station.id, d.reason])).toEqual([
      ['onEarly', 'onRoute'],
      ['byDest2', 'nearDestination'],
      ['byDest', 'nearDestination'],
    ])
  })

  it('a kept dock near the destination that still has room needs no second one', () => {
    const stations = [st('onEarly', 1500, 10), st('byDest', 3000, 300), st('byDest2', 2900, 350)]
    expect(routeDocks(route, stations, { destination: B, keepIds: ['byDest2'] }).map((d) => d.station.id)).toEqual(['onEarly', 'byDest2'])
  })

  it('uses the rider max ride time for re-dock options', () => {
    const C = along(9000)
    const stations = [st('late', 8500, 10), st('offLate', 5500, 200), st('offMid', 3000, 200)]
    // 15 min ≈ 3.5 km at 14 km/h: the re-dock has to come earlier.
    expect(routeDocks([A, C], stations, { destination: C, maxRideMinutes: 15 }).map((d) => d.station.id)).toEqual(['offMid', 'offLate', 'late'])
  })
})

describe('optimizedStops', () => {
  // 12 km route; at 14 km/h, 25 min ≈ 5.83 km and 15 min = 3.5 km.
  const D = along(12_000)
  const route: LngLat[] = [A, D]
  const stations = ['2000', '4000', '5500', '7000', '9000'].map((m) => st(`d${m}`, Number(m), 10)).concat(st('end', 11_900, 10))
  const docks = routeDocks(route, stations, { destination: D })

  it('preselects only the fewest docks that keep every ride within the limit, ending near the destination', () => {
    expect(optimizedStops(docks, { destination: D })).toEqual(['d5500', 'd9000', 'end'])
  })

  it('re-plans for a shorter max ride time', () => {
    // 0→5.5 km is 10 m (the detour to the dock) over 15 min, so it re-docks at 2 and 4 km instead.
    expect(optimizedStops(docks, { destination: D, maxRideMinutes: 15 })).toEqual(['d2000', 'd4000', 'd7000', 'd9000', 'end'])
  })

  it('unlimited (0) keeps just the end dock and adds no re-dock options', () => {
    expect(optimizedStops(docks, { destination: D, maxRideMinutes: 0 })).toEqual(['end'])
    const C = along(9000)
    expect(routeDocks([A, C], [st('late', 8500, 10), st('offLate', 5500, 200)], { destination: C, maxRideMinutes: 0 }).map((d) => d.station.id)).toEqual(['late'])
  })

  it('needs no re-dock on a short ride', () => {
    const short = routeDocks([A, along(3000)], [st('on1', 1000, 20), st('on2', 2950, 30)], { destination: along(3000) })
    expect(optimizedStops(short, { destination: along(3000) })).toEqual(['on2'])
  })

  it('skips docks without room and accepts a long stretch when no dock is in range', () => {
    const sparse = routeDocks(route, [st('full', 5000, 10, { docks: 0 }), st('far', 8000, 10), st('end', 11_900, 10)], { destination: D })
    expect(optimizedStops(sparse, { destination: D })).toEqual(['far', 'end'])
    expect(optimizedStops(sparse, { destination: D, partySize: 9 })).toEqual([])
  })
})
