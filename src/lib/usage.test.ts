import { describe, expect, it } from 'vitest'
import { addDays, dayGap, dayKey, firstOfDay, hourOf, isDayKey, parseUsageMemory, windowOf } from './usage'

const TZ = 'America/Chicago'

describe('usage days and windows', () => {
  it('days and hours are in the counting time zone, across midnight and DST', () => {
    // 2026-11-19 05:30 UTC is still the 18th, 23:30, in Chicago (CST, UTC−6).
    expect([dayKey(Date.UTC(2026, 10, 19, 5, 30), TZ), hourOf(Date.UTC(2026, 10, 19, 5, 30), TZ)]).toEqual(['2026-11-18', 23])
    expect([dayKey(Date.UTC(2026, 10, 19, 6, 0), TZ), hourOf(Date.UTC(2026, 10, 19, 6, 0), TZ)]).toEqual(['2026-11-19', 0])
    // Summer (CDT, UTC−5).
    expect(hourOf(Date.UTC(2026, 6, 1, 17, 0), TZ)).toBe(12)
  })

  it('counts calendar days between day keys, including over DST changes and month ends', () => {
    expect([dayGap('2026-03-07', '2026-03-09'), dayGap('2026-10-31', '2026-11-02'), dayGap('2026-12-31', '2027-01-01')]).toEqual([2, 2, 1])
    expect([addDays('2026-03-01', -1), addDays('2026-12-31', 1), addDays('2026-11-19', -89)]).toEqual(['2026-02-28', '2027-01-01', '2026-08-22'])
    expect([isDayKey('2026-11-19'), isDayKey('2026-1-9'), isDayKey(20261119), isDayKey('2026-11-19x')]).toEqual([true, false, false, false])
  })

  it('reports a first open of the day with the gap since the previous active day, once', () => {
    expect(firstOfDay({ day: null, window: null }, '2026-11-19', 90)).toEqual({ gap: null }) // a new device
    expect(firstOfDay({ day: '2026-11-18', window: 1 }, '2026-11-19', 90)).toEqual({ gap: 1 })
    expect(firstOfDay({ day: '2026-01-01', window: 1 }, '2026-11-19', 90)).toEqual({ gap: 90 }) // capped
    expect(firstOfDay({ day: '2026-11-19', window: 1 }, '2026-11-19', 90)).toBeNull() // already counted today
    expect(firstOfDay({ day: '2026-11-20', window: 1 }, '2026-11-19', 90)).toBeNull() // the clock went back
  })

  it('reads only what it stores, ignoring anything malformed', () => {
    expect(parseUsageMemory({ day: '2026-11-19', window: 5, id: 'x' })).toEqual({ day: '2026-11-19', window: 5 })
    expect(parseUsageMemory({ day: 'yesterday', window: 1.5 })).toEqual({ day: null, window: null })
    expect(parseUsageMemory(null)).toEqual({ day: null, window: null })
    expect(windowOf(10 * 300_000 + 299_999, 300_000)).toBe(10)
  })
})
