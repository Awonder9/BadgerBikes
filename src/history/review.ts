// Weekly, monthly and yearly reviews of the rides on this device ("your year on Badger Bikes"): totals, records,
// favorite docks, habits, a ride persona. Pure: no DOM; the time zone (the rider's own) is injected, and periods are
// calendar days in it (src/lib/usage.ts day keys, DST-safe).
import { HISTORY } from '../config'
import { addDays, dayGap } from '../lib/usage'
import type { PathKind } from '../routing/details'
import { previousPeriod, ridesIn, startOf, weekday, type Period } from './periods'
import { rideSecondsOf, type RideRecord } from './rides'

export { nextPeriod, periodContaining, previousPeriod, reviewToOffer, ridesIn, type Period, type PeriodKind } from './periods'

export type Persona = 'trailblazer' | 'explorer' | 'commuter' | 'earlyBird' | 'nightOwl' | 'weekendWarrior' | 'loopLover' | 'steady'
export type TimeOfDay = 'morning' | 'midday' | 'evening' | 'night'

export interface Count {
  name: string
  count: number
}

export interface Review {
  period: Period
  rides: number
  meters: number
  seconds: number
  /** Days with at least one ride, and the most in a row. */
  activeDays: number
  longestStreak: number
  longest: RideRecord | null
  topStart: Count | null
  topEnd: Count | null
  /** The most ridden start → end pair (2+ rides). */
  topRoute: { from: string; to: string; count: number } | null
  /** Different docks ridden from or to. */
  docks: number
  /** Meters on bike paths, shared-use paths and protected lanes, of the rides whose path details were known. */
  trailMeters: number
  /** trailMeters ÷ the meters those rides covered (null: no ride's details known). */
  trailShare: number | null
  climbM: number
  loops: number
  /** Places "Just ride" passed, most often first. */
  places: Count[]
  timeOfDay: TimeOfDay | null
  /** 0 = Sunday … 6 = Saturday (null: no rides). */
  busiestWeekday: number | null
  /** Rides per day (week, month) or per month (year), for the chart. */
  buckets: number[]
  /** Car CO₂ avoided (kg) and riding calories (kcal), estimates (HISTORY). */
  co2Kg: number
  kcal: number
  /** Share of rides on an e-bike. */
  ebikeShare: number
  /** Distance compared with the period before (+0.25 = 25 % more); null when that one had no rides. */
  vsPrevious: number | null
  persona: Persona
}

const TRAIL_KINDS: readonly PathKind[] = ['bikePath', 'sharedPath', 'protectedLane']

function top(names: readonly string[]): Count | null {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  let best: Count | null = null
  for (const [name, count] of counts) if (!best || count > best.count) best = { name, count }
  return best
}

const timeOfDayOf = (hour: number): TimeOfDay => (hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 16 ? 'midday' : hour >= 16 && hour < 21 ? 'evening' : 'night')

/** The longest run of consecutive days among `days` (sorted YYYY-MM-DD, no repeats). */
export function longestStreak(days: readonly string[]): number {
  let best = 0
  let run = 0
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && dayGap(days[i - 1]!, days[i]!) === 1 ? run + 1 : 1
    best = Math.max(best, run)
  }
  return best
}

/** The review of `p` from every ride on the device (rides outside it are ignored; the period before is compared). */
export function buildReview(all: readonly RideRecord[], p: Period, timeZone: string): Review {
  const rides = ridesIn(all, p, timeZone)
  const prev = ridesIn(all, previousPeriod(p), timeZone)
  const meters = rides.reduce((s, r) => s + r.meters, 0)
  const seconds = rides.reduce((s, r) => s + rideSecondsOf(r), 0)
  const days = [...new Set(rides.map((r) => startOf(r, timeZone).day))].sort()
  const pairs = top(rides.map((r) => `${r.startName}\u0000${r.endName}`))
  const withPaths = rides.filter((r) => Object.keys(r.pathM).length > 0)
  const pathTotal = withPaths.reduce((s, r) => s + Object.values(r.pathM).reduce((a, b) => a + (b ?? 0), 0), 0)
  const trailMeters = withPaths.reduce((s, r) => s + TRAIL_KINDS.reduce((a, k) => a + (r.pathM[k] ?? 0), 0), 0)
  const hours = rides.map((r) => startOf(r, timeZone).hour)
  const tod = top(hours.map(timeOfDayOf))
  const weekdays = days.map(weekday)
  const wd = top(rides.map((r) => String(weekday(startOf(r, timeZone).day))))
  // Rides per day (or month, for a year), counted in one pass.
  const perBucket = new Map<string, number>()
  for (const r of rides) {
    const day = startOf(r, timeZone).day
    const key = p.kind === 'year' ? day.slice(5, 7) : day
    perBucket.set(key, (perBucket.get(key) ?? 0) + 1)
  }
  const buckets =
    p.kind === 'year'
      ? Array.from({ length: 12 }, (_, m) => perBucket.get(String(m + 1).padStart(2, '0')) ?? 0)
      : Array.from({ length: dayGap(p.first, p.last) + 1 }, (_, i) => perBucket.get(addDays(p.first, i)) ?? 0)
  const kcal = rides.reduce((s, r) => s + HISTORY.met[r.electric ? 'electric' : 'classic'] * HISTORY.assumedWeightKg * (rideSecondsOf(r) / 3600), 0)
  const prevMeters = prev.reduce((s, r) => s + r.meters, 0)
  const docks = new Set(rides.flatMap((r) => [`${r.systemId}:${r.startStationId}`, ...(r.endStationId ? [`${r.systemId}:${r.endStationId}`] : [])])).size
  const loops = rides.filter((r) => r.kind === 'loop').length
  const trailShare = pathTotal > 0 ? trailMeters / pathTotal : null
  const review: Review = {
    period: p,
    rides: rides.length,
    meters,
    seconds,
    activeDays: days.length,
    longestStreak: longestStreak(days),
    longest: rides.reduce<RideRecord | null>((m, r) => (!m || r.meters > m.meters ? r : m), null),
    topStart: top(rides.map((r) => r.startName)),
    topEnd: top(rides.map((r) => r.endName)),
    topRoute: pairs && pairs.count >= 2 ? { from: pairs.name.split('\u0000')[0]!, to: pairs.name.split('\u0000')[1]!, count: pairs.count } : null,
    docks,
    trailMeters,
    trailShare,
    climbM: rides.reduce((s, r) => s + (r.climbM ?? 0), 0),
    loops,
    places: [...rides.flatMap((r) => r.highlights).reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map<string, number>())]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    timeOfDay: (tod?.name as TimeOfDay | undefined) ?? null,
    busiestWeekday: wd ? Number(wd.name) : null,
    buckets,
    co2Kg: (meters / 1000) * HISTORY.co2KgPerKm,
    kcal,
    ebikeShare: rides.length ? rides.filter((r) => r.electric).length / rides.length : 0,
    vsPrevious: prevMeters > 0 ? meters / prevMeters - 1 : null,
    persona: 'steady',
  }
  review.persona = personaOf(review, hours, weekdays)
  return review
}

/** The rider's style this period, from the strongest habit (checked in this order). */
function personaOf(r: Review, hours: readonly number[], weekdays: readonly number[]): Persona {
  if (r.rides === 0) return 'steady'
  const share = (n: number) => n / r.rides
  if (r.loops >= 2 && share(r.loops) >= 0.5) return 'loopLover'
  if (r.trailShare !== null && r.trailShare >= 0.5) return 'trailblazer'
  if (r.topRoute && r.topRoute.count >= 3 && share(r.topRoute.count) >= 0.4) return 'commuter'
  if (r.docks >= 6 && r.docks >= r.rides * 0.8) return 'explorer'
  if (hours.filter((h) => h >= 5 && h < 9).length / r.rides >= 0.5) return 'earlyBird'
  if (hours.filter((h) => h >= 21 || h < 5).length / r.rides >= 0.4) return 'nightOwl'
  if (weekdays.length >= 2 && weekdays.filter((d) => d === 0 || d === 6).length / weekdays.length >= 0.6) return 'weekendWarrior'
  return 'steady'
}

