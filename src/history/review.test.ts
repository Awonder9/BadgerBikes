import { describe, expect, it } from 'vitest'
import { HISTORY } from '../config'
import { buildReview, longestStreak, nextPeriod, periodContaining, previousPeriod, reviewToOffer } from './review'
import { capRides, decodeLine, encodeLine, rideEnd, validateRide, type RideRecord } from './rides'
import { restoreHistory } from './historyStore'

const TZ = 'America/Chicago'
/** Noon in Madison on a day (CST = UTC−6 in November). */
const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour + 6).padStart(2, '0')}:00:00Z`)

let n = 0
const ride = (o: Partial<RideRecord> = {}): RideRecord => ({
  id: `r${++n}`,
  systemId: 'bcycle_madison',
  startedAtMs: at('2026-11-18'),
  endedAtMs: at('2026-11-18') + 15 * 60_000,
  endEstimated: false,
  startName: 'Capitol',
  startStationId: 'cap',
  endName: 'Memorial Union',
  endStationId: 'mu',
  destName: 'Memorial Union',
  meters: 2_000,
  plannedS: 600,
  electric: true,
  kind: 'ride',
  line: null,
  pathM: {},
  climbM: null,
  highlights: [],
  stravaActivityId: null,
  ...o,
})

describe('periods', () => {
  it('weeks run Monday to Sunday; months and years are calendar ones', () => {
    expect(periodContaining('week', '2026-11-24')).toEqual({ kind: 'week', key: 'week:2026-11-23', first: '2026-11-23', last: '2026-11-29' })
    expect(periodContaining('week', '2026-11-23').first).toBe('2026-11-23') // a Monday is its own week's first day
    expect(periodContaining('week', '2026-11-22').first).toBe('2026-11-16') // a Sunday ends the week before
    expect(periodContaining('month', '2028-02-10')).toMatchObject({ key: 'month:2028-02', first: '2028-02-01', last: '2028-02-29' })
    expect(periodContaining('year', '2026-07-04')).toMatchObject({ key: 'year:2026', first: '2026-01-01', last: '2026-12-31' })
    expect(previousPeriod(periodContaining('month', '2026-01-15')).key).toBe('month:2025-12')
    expect(nextPeriod(periodContaining('week', '2026-12-30')).key).toBe('week:2027-01-04')
  })

  it('counts days in a row', () => {
    expect(longestStreak([])).toBe(0)
    expect(longestStreak(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06'])).toBe(3)
    // Across the DST change (Nov 1, 2026 in the US) and a month end.
    expect(longestStreak(['2026-10-31', '2026-11-01', '2026-11-02'])).toBe(3)
  })
})

describe('buildReview', () => {
  it('adds up the period’s rides and compares with the one before', () => {
    const rides = [
      ride({ startedAtMs: at('2026-11-16', 8), endedAtMs: at('2026-11-16', 8) + 10 * 60_000, meters: 3_000 }),
      ride({ startedAtMs: at('2026-11-17', 8), endedAtMs: at('2026-11-17', 8) + 20 * 60_000, meters: 5_000, electric: false }),
      ride({ startedAtMs: at('2026-11-18', 8), endedAtMs: at('2026-11-18', 8) + 12 * 60_000, meters: 2_000 }),
      // The week before: 5 km.
      ride({ startedAtMs: at('2026-11-10'), meters: 5_000 }),
      // Under way: not counted.
      ride({ startedAtMs: at('2026-11-19'), endedAtMs: null }),
    ]
    const r = buildReview(rides, periodContaining('week', '2026-11-18'), TZ)
    expect(r).toMatchObject({ rides: 3, meters: 10_000, seconds: 42 * 60, activeDays: 3, longestStreak: 3, docks: 2, timeOfDay: 'morning', busiestWeekday: 1 })
    expect(r.longest?.meters).toBe(5_000)
    expect(r.topRoute).toEqual({ from: 'Capitol', to: 'Memorial Union', count: 3 })
    expect(r.buckets).toEqual([1, 1, 1, 0, 0, 0, 0])
    expect(r.vsPrevious).toBeCloseTo(1) // twice as far
    expect(r.co2Kg).toBeCloseTo(10 * HISTORY.co2KgPerKm)
    expect(r.ebikeShare).toBeCloseTo(2 / 3)
    expect(r.kcal).toBeCloseTo(HISTORY.assumedWeightKg * ((HISTORY.met.electric * 22) / 60 + (HISTORY.met.classic * 20) / 60))
    // Three of three rides on one route, every one of them before 9 am.
    expect(r.persona).toBe('commuter')
  })

  it('a year has a bucket per month; trail share comes from rides with path details', () => {
    const rides = [
      ride({ startedAtMs: at('2026-03-05'), pathM: { bikePath: 3_000, quietStreet: 1_000 } }),
      ride({ startedAtMs: at('2026-03-06'), pathM: { sharedPath: 1_000, busyRoad: 1_000 }, startName: 'A', endName: 'B', startStationId: 'a', endStationId: 'b' }),
      ride({ startedAtMs: at('2026-07-06') }), // no details: not in the share
    ]
    const r = buildReview(rides, periodContaining('year', '2026-06-01'), TZ)
    expect(r.buckets).toEqual([0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0])
    expect(r.trailMeters).toBe(4_000)
    expect(r.trailShare).toBeCloseTo(4 / 6)
    expect(r.persona).toBe('trailblazer')
    expect(r.vsPrevious).toBeNull()
  })

  it('names loop riders and the places their loops passed', () => {
    const rides = [
      ride({ kind: 'loop', highlights: ['Lake Mendota', 'Tenney Park'], startedAtMs: at('2026-11-02', 14) }),
      ride({ kind: 'loop', highlights: ['Lake Mendota'], startedAtMs: at('2026-11-03', 14) }),
    ]
    const r = buildReview(rides, periodContaining('month', '2026-11-10'), TZ)
    expect(r.loops).toBe(2)
    expect(r.places[0]).toEqual({ name: 'Lake Mendota', count: 2 })
    expect(r.persona).toBe('loopLover')
  })

  it('an empty period is all zeros', () => {
    const r = buildReview([], periodContaining('month', '2026-11-10'), TZ)
    expect(r).toMatchObject({ rides: 0, meters: 0, longest: null, topStart: null, timeOfDay: null, persona: 'steady' })
  })
})

describe('reviewToOffer', () => {
  const lastWeek = [ride({ startedAtMs: at('2026-11-18') })]
  it('offers last week’s review early in a week, once', () => {
    expect(reviewToOffer(lastWeek, at('2026-11-24'), TZ, [])?.key).toBe('week:2026-11-16')
    expect(reviewToOffer(lastWeek, at('2026-11-24'), TZ, ['week:2026-11-16'])).toBeNull()
    expect(reviewToOffer(lastWeek, at('2026-11-27'), TZ, [])).toBeNull() // Friday: too late
  })
  it('offers last month’s early in a month, and the year’s in December and January', () => {
    const rides = [ride({ startedAtMs: at('2026-11-18') })]
    expect(reviewToOffer(rides, at('2026-12-03'), TZ, [])?.key).toBe('year:2026')
    expect(reviewToOffer(rides, at('2026-12-03'), TZ, ['year:2026'])?.key).toBe('month:2026-11')
    expect(reviewToOffer(rides, at('2027-01-20'), TZ, [])?.key).toBe('year:2026')
    expect(reviewToOffer(rides, at('2027-02-02'), TZ, [])).toBeNull()
  })
})

describe('ride records', () => {
  it('end when the rider ended them, unless implausibly late; an unseen end is estimated', () => {
    const start = 1_800_000_000_000
    expect(rideEnd(start, 900, start + 20 * 60_000, true)).toEqual({ endedAtMs: start + 20 * 60_000, endEstimated: false })
    expect(rideEnd(start, 900, start + 30_000, true)).toBeNull() // a mis-tap
    expect(rideEnd(start, 900, start + 5 * 60 * 60_000, true)).toEqual({ endedAtMs: start + 900_000, endEstimated: true })
    expect(rideEnd(start, 900, start + 5 * 60_000, false)).toEqual({ endedAtMs: start + 900_000, endEstimated: true })
  })

  it('keep a thinned route line, only on the newest rides', () => {
    const line = encodeLine([[-89.38, 43.07], [-89.38001, 43.07001], [-89.39, 43.075], [-89.4, 43.076]])
    expect(decodeLine(line)).toHaveLength(3)
    expect(decodeLine('not a polyline\u0000')).toBeNull()
    const many = Array.from({ length: HISTORY.maxRidesWithLine + 2 }, (_, i) => ride({ startedAtMs: 1_000_000 + i, line }))
    const capped = capRides(many)
    expect(capped[0]!.startedAtMs).toBe(1_000_000 + HISTORY.maxRidesWithLine + 1)
    expect(capped.filter((r) => r.line !== null)).toHaveLength(HISTORY.maxRidesWithLine)
  })

  it('are validated on restore: bad ones are dropped, names cleaned', () => {
    const good = ride({ id: 'ok', startName: 'Cap<b>itol\u0007' })
    expect(validateRide(good)).toMatchObject({ startName: 'Capbitol' })
    expect(validateRide({ ...good, startedAtMs: 'x' })).toBeNull()
    expect(validateRide({ ...good, endedAtMs: good.startedAtMs - 1 })).toBeNull()
    expect(validateRide({ ...good, stravaActivityId: 'javascript:1' })?.stravaActivityId).toBeNull()
    const open = ride({ id: 'open', endedAtMs: null })
    const h = restoreHistory({ rides: [good, open, { junk: true }], active: { id: 'open', planKey: 'k' }, seenReviews: ['week:2026-11-16', 'bogus'] })
    expect(h.rides.map((r) => r.id)).toEqual(['ok', 'open'])
    expect(h.active).toEqual({ id: 'open', planKey: 'k', ridden: true }) // saved by an older version: taken as set off on
    expect(h.seenReviews).toEqual(['week:2026-11-16'])
    // An open ride nobody is recording any more can't be closed: dropped.
    expect(restoreHistory({ rides: [open] }).rides).toEqual([])
  })
})

describe('reviews of a long history', () => {
  it('stay quick: each ride’s day is worked out once, not once per day of the period', () => {
    const tz = 'America/Chicago'
    const start = Date.UTC(2026, 0, 1, 18)
    const rides = Array.from({ length: HISTORY.maxRides }, (_, i) => ride({ id: `x${i}`, startedAtMs: start + i * 4 * 3_600_000, endedAtMs: start + i * 4 * 3_600_000 + 900_000 }))
    const t0 = performance.now()
    const year = buildReview(rides, periodContaining('year', '2026-06-01'), tz)
    const month = buildReview(rides, periodContaining('month', '2026-03-10'), tz)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(year.buckets.reduce((a, b) => a + b, 0)).toBe(year.rides)
    expect(month.buckets).toHaveLength(31)
    expect(month.buckets.reduce((a, b) => a + b, 0)).toBe(month.rides)
  })
})
