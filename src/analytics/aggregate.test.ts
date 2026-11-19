import { describe, expect, it } from 'vitest'
import type { StatsDay, StatsResponse } from '../api/contract'
import { addDays } from '../lib/usage'
import { change, foldTail, niceTicks, summarizeRange } from './aggregate'

const day = (i: number, o: Partial<StatsDay> = {}): StatsDay => ({
  day: addDays('2026-11-19', i - 179),
  users: 2,
  users7: 7,
  users30: 30,
  users90: 90,
  newUsers: 1,
  opens: 3,
  peakActive: 1,
  beats: Array.from({ length: 24 }, (_, h) => (h === 8 ? 24 : 0)),
  counts: { ride_start: 1, routes: 2 },
  cities: { bcycle_madison: 2 },
  platforms: { ios: 1, android: 1 },
  installed: 1,
  langs: { en: 2 },
  ...o,
})
const stats = (days: StatsDay[], since: string | null = days[0]?.day ?? null): StatsResponse => ({ timeZone: 'America/Chicago', generatedAtMs: 0, activeNow: 0, allTimeUsers: 9, since, days })

describe('usage dashboard numbers', () => {
  const all = Array.from({ length: 180 }, (_, i) => day(i))

  it('sums the chosen range, and compares unique users with the period before', () => {
    all[179 - 30] = day(179 - 30, { users30: 20 })
    const r = summarizeRange(stats(all), 30)
    expect(r.days).toHaveLength(30)
    expect([r.users, r.usersBefore, r.today, r.newUsers, r.opens, r.ridesStarted, r.routes]).toEqual([30, 20, 2, 30, 90, 30, 60])
    expect(change(r.users, r.usersBefore)).toBeCloseTo(0.5)
    expect(r.platforms).toEqual([
      { key: 'android', value: 30 },
      { key: 'ios', value: 30 },
    ])
    expect(r.installed).toEqual([
      { key: 'installed', value: 30 },
      { key: 'browser', value: 30 },
    ])
    expect(r.hourly[8]).toBe(2) // 24 check-ins an hour = 2 devices open on average
    expect(r.features.find((f) => f.key === 'routes_busy')).toEqual({ key: 'routes_busy', value: 0 })
  })

  it('makes no comparison before counting had begun', () => {
    expect(summarizeRange(stats(all, all[170]!.day), 30).usersBefore).toBeNull()
    expect(change(5, null)).toBeNull()
    expect(change(5, 0)).toBeNull()
  })

  it('folds a long tail into "other" and picks round axis ticks', () => {
    const shares = [5, 4, 3, 2, 1].map((value, i) => ({ key: `c${i}`, value }))
    expect(foldTail(shares, 3)).toEqual([...shares.slice(0, 3), { key: 'other', value: 3 }])
    expect(foldTail(shares, 4)).toEqual(shares) // folding one row into "other" hides it for nothing
    expect([niceTicks(0), niceTicks(7), niceTicks(42), niceTicks(1300)]).toEqual([
      [0, 1],
      [0, 2, 4, 6, 8],
      [0, 20, 40, 60],
      [0, 500, 1000, 1500],
    ])
  })
})
