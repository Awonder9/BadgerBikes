import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageFirst, UsageRequest } from '../src/api/contract'
import { USAGE } from '../src/config'
import { addDays, dayKey, firstOfDay, type UsageMemory } from '../src/lib/usage'
import { Usage } from './usage'
import { activeNow, applyUsage, dailyUsers, emptyDay, summarize, uniqueUsers, type UsageDayRecord, type WindowState } from './usageCore'

const first = (gap: number | null, o: Partial<UsageFirst> = {}): UsageFirst => ({ gap, systemId: 'bcycle_madison', platform: 'ios', installed: false, lang: 'en', ...o })

/** A small deterministic PRNG (mulberry32), so the simulation is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('usage counts: unique devices without identifiers', () => {
  it('match the true number of distinct devices for every day and 7/30/90-day window', () => {
    // 400 devices with their own habits over 200 days, each reporting exactly what the app reports (its first
    // open of the day, with the gap since its previous active day). The server sees only those reports.
    const rand = random(7)
    const start = '2026-01-01'
    const days = 200
    const records = new Map<string, UsageDayRecord>()
    const truth = new Map<string, Set<number>>()
    for (let device = 0; device < 400; device++) {
      const joins = Math.floor(rand() * days)
      const habit = rand() < 0.2 ? 0.8 : rand() < 0.5 ? 0.15 : 0.02 // daily riders, weekly-ish, rare
      const memory: UsageMemory = { day: null, window: null }
      for (let d = joins; d < days; d++) {
        if (rand() > habit) continue
        const today = addDays(start, d)
        // Several opens on a day: only the first is reported as the day's first.
        for (let open = 0; open < 1 + Math.floor(rand() * 3); open++) {
          const f = firstOfDay(memory, today, USAGE.maxGapDays)
          const record = records.get(today) ?? emptyDay()
          applyUsage(record, null, { kind: 'open', first: f ? first(f.gap) : null }, { window: 0, hour: 12 })
          records.set(today, record)
          memory.day = today
        }
        if (!truth.has(today)) truth.set(today, new Set())
        truth.get(today)!.add(device)
      }
    }
    const distinct = (end: string, length: number) => {
      const all = new Set<number>()
      for (let k = 0; k < length; k++) for (const device of truth.get(addDays(end, -k)) ?? []) all.add(device)
      return all.size
    }
    const mismatches: string[] = []
    for (let d = 0; d < days; d++) {
      const day = addDays(start, d)
      const counted = [dailyUsers(records.get(day) ?? emptyDay()), uniqueUsers(records, day, 7), uniqueUsers(records, day, 30), uniqueUsers(records, day, 90)]
      const actual = [distinct(day, 1), distinct(day, 7), distinct(day, 30), distinct(day, 90)]
      if (counted.join() !== actual.join()) mismatches.push(`${day}: counted ${counted.join('/')}, actual ${actual.join('/')}`)
    }
    expect(mismatches).toEqual([])
    expect(distinct(addDays(start, days - 1), 90)).toBeGreaterThan(100) // the simulation is not trivially small
  })

  it('counts opens, check-ins by hour, the busiest window, new devices and the daily breakdowns', () => {
    const day = emptyDay()
    let state: WindowState | null = null
    const reports: Array<[UsageRequest, number]> = [
      [{ kind: 'open', first: first(null, { platform: 'android', installed: true, lang: 'zh-Hant' }) }, 100],
      [{ kind: 'open', first: first(3) }, 100],
      [{ kind: 'beat', first: null }, 101],
      [{ kind: 'open', first: null }, 101],
      [{ kind: 'event', name: 'share' }, 101],
    ]
    for (const [req, window] of reports) state = applyUsage(day, state, req, { window, hour: 8 }).state
    expect(day).toMatchObject({ newUsers: 1, opens: 3, peakActive: 2, installed: 1, cities: { bcycle_madison: 2 }, platforms: { android: 1, ios: 1 }, langs: { 'zh-Hant': 1, en: 1 }, counts: { share: 1 } })
    expect([day.gaps[2], day.beats[8], dailyUsers(day)]).toEqual([1, 4, 2])
    expect(state).toEqual({ window: 101, count: 2, previous: 2 })
  })

  it('"active now" is the current window, or the previous one while the current is still filling', () => {
    expect(activeNow({ window: 10, count: 1, previous: 5 }, 10)).toBe(5)
    expect(activeNow({ window: 10, count: 6, previous: 5 }, 10)).toBe(6)
    expect(activeNow({ window: 10, count: 6, previous: 5 }, 11)).toBe(6) // nobody checked in yet this window
    expect(activeNow({ window: 10, count: 6, previous: 5 }, 12)).toBe(0)
    expect(activeNow(null, 12)).toBe(0)
  })

  it('the dashboard covers the days asked for, oldest first, with empty days filled in', () => {
    const records = new Map([['2026-11-18', { ...emptyDay(), newUsers: 2 }]])
    const r = summarize(records, { today: '2026-11-19', days: 3, nowMs: 1, window: 0, state: null, allTime: 2, since: '2026-11-18' })
    expect(r.days.map((d) => [d.day, d.users, d.users7])).toEqual([
      ['2026-11-17', 0, 0],
      ['2026-11-18', 2, 2],
      ['2026-11-19', 0, 2],
    ])
    expect(r).toMatchObject({ timeZone: USAGE.timeZone, allTimeUsers: 2, since: '2026-11-18', activeNow: 0 })
  })
})

function fakeStorage() {
  const data = new Map<string, unknown>()
  const inRange = (k: string, o: { prefix?: string; start?: string; end?: string }) => (!o.prefix || k.startsWith(o.prefix)) && (!o.start || k >= o.start) && (!o.end || k < o.end)
  return {
    data,
    storage: {
      get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))])) : structuredClone(data.get(k))),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') data.set(k, structuredClone(v))
        else for (const [key, value] of Object.entries(k)) data.set(key, structuredClone(value))
      },
      list: async (o: { prefix?: string; start?: string; end?: string }) => new Map([...data].filter(([k]) => inRange(k, o)).sort(([a], [b]) => (a < b ? -1 : 1))),
      delete: async (keys: string[]) => keys.forEach((k) => data.delete(k)),
    },
  }
}

describe('Usage Durable Object', () => {
  const T0 = Date.UTC(2026, 10, 19, 18, 0) // 12:00 in Chicago
  beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  it('stores counts per day and reports them, with the all-time total and who is active now', async () => {
    const fake = fakeStorage()
    const usage = new Usage({ storage: fake.storage } as never, {} as never)
    await usage.record({ kind: 'open', first: first(null) })
    await usage.record({ kind: 'open', first: first(30) }) // back after a month
    await usage.record({ kind: 'event', name: 'ride_start' })
    await usage.count('routes')
    vi.setSystemTime(T0 + 24 * 60 * 60_000) // the next day
    await usage.record({ kind: 'open', first: first(1) })
    await usage.record({ kind: 'open', first: first(null) })
    const r = await usage.report(2)
    expect(r.days.map((d) => [d.day, d.users, d.newUsers, d.users7])).toEqual([
      ['2026-11-19', 2, 1, 2],
      ['2026-11-20', 2, 1, 3],
    ])
    expect(r.days[0]!.counts).toEqual({ ride_start: 1, routes: 1 })
    expect(r).toMatchObject({ allTimeUsers: 2, since: '2026-11-19', activeNow: 2 })
    expect(r.days[1]!.beats[12]).toBe(2) // noon in Chicago
    // Nothing stored can tell devices apart: just counts.
    expect([...fake.data.keys()].sort()).toEqual(['d:2026-11-19', 'd:2026-11-20', 'total', 'window'])
  })

  it('keeps enough days for the longest report: its first day still needs the 89 days before it', () => {
    expect(USAGE.keepDays).toBeGreaterThanOrEqual(USAGE.maxReportDays + USAGE.maxGapDays - 1)
  })

  it('deletes days older than USAGE.keepDays when a new day starts', async () => {
    const fake = fakeStorage()
    const today = dayKey(T0, USAGE.timeZone)
    fake.data.set(`d:${addDays(today, -USAGE.keepDays - 1)}`, emptyDay())
    fake.data.set(`d:${addDays(today, -USAGE.keepDays + 1)}`, emptyDay())
    await new Usage({ storage: fake.storage } as never, {} as never).record({ kind: 'beat', first: null })
    expect([...fake.data.keys()].filter((k) => k.startsWith('d:')).sort()).toEqual([`d:${addDays(today, -USAGE.keepDays + 1)}`, `d:${today}`])
  })
})
