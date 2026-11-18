import { describe, expect, it } from 'vitest'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import type { LngLat } from '../types'
import { preselectRouteDocks, routeDocks } from './stationsAlongRoute'

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

  it('always includes a destination dock the rider chose, and preselects only usable docks', () => {
    const r = routeDocks(route, [st('dest', 3000, 45), st('full', 1200, 5, { docks: 0 })], { destination: B, destStationId: 'dest' })
    expect(r.map((d) => d.station.id)).toEqual(['full', 'dest'])
    expect(preselectRouteDocks(r)).toEqual(['dest'])
  })
})
