// Calendar periods of the ride history — weeks (Monday–Sunday), months and years in the rider's own time zone — and
// which review the home panel offers. Small on purpose: the home panel needs it at startup, while the reviews themselves
// (review.ts) load with "Your rides". Pure: no DOM; the time zone is injected.
import { HISTORY } from '../config'
import { addDays, dayAndHour, dayGap, dayKey } from '../lib/usage'
import type { RideRecord } from './rides'

export type PeriodKind = 'week' | 'month' | 'year'

export interface Period {
  kind: PeriodKind
  /** "week:2026-11-17" (its Monday), "month:2026-11", "year:2026" — also what "seen" remembers. */
  key: string
  /** First and last day (YYYY-MM-DD), inclusive. */
  first: string
  last: string
}

const pad = (n: number) => String(n).padStart(2, '0')
export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay()
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m: 1–12

/** The week, month or year that contains `day` (YYYY-MM-DD). Weeks start on HISTORY.weekStartsOn (Monday). */
export function periodContaining(kind: PeriodKind, day: string): Period {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  if (kind === 'year') return { kind, key: `year:${y}`, first: `${y}-01-01`, last: `${y}-12-31` }
  if (kind === 'month') return { kind, key: `month:${y}-${pad(m)}`, first: `${y}-${pad(m)}-01`, last: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` }
  const first = addDays(day, -((weekday(day) - HISTORY.weekStartsOn + 7) % 7))
  return { kind, key: `week:${first}`, first, last: addDays(first, 6) }
}

export const previousPeriod = (p: Period): Period => periodContaining(p.kind, addDays(p.first, -1))
export const nextPeriod = (p: Period): Period => periodContaining(p.kind, addDays(p.last, 1))

/**
 * A ride's start as a calendar day and hour in `timeZone`, worked out once per ride: Intl is slow, and the reviews and
 * the home panel's offer ask about every ride of a long history (records are replaced, never changed, when edited).
 */
const startCache = new WeakMap<RideRecord, { timeZone: string; day: string; hour: number }>()
export function startOf(r: RideRecord, timeZone: string): { day: string; hour: number } {
  const hit = startCache.get(r)
  if (hit && hit.timeZone === timeZone) return hit
  const at = { timeZone, ...dayAndHour(r.startedAtMs, timeZone) }
  startCache.set(r, at)
  return at
}

/** Finished rides that started in `p` (in `timeZone`). */
export function ridesIn(rides: readonly RideRecord[], p: Period, timeZone: string): RideRecord[] {
  return rides.filter((r) => {
    if (r.endedAtMs === null) return false
    const day = startOf(r, timeZone).day
    return day >= p.first && day <= p.last
  })
}

/**
 * The review to offer on the home panel now, if any: the year's from December through January (Wrapped season), else
 * last month's in the first days of a month, else last week's in the first days of a week — only one with rides that
 * the rider hasn't opened yet.
 */
export function reviewToOffer(rides: readonly RideRecord[], nowMs: number, timeZone: string, seen: readonly string[]): Period | null {
  const today = dayKey(nowMs, timeZone)
  const month = Number(today.slice(5, 7)) - 1
  const candidates: Period[] = []
  if (month >= HISTORY.yearlyFromMonth) candidates.push(periodContaining('year', today))
  else if (month === 0) candidates.push(periodContaining('year', addDays(today, -40)))
  const thisMonth = periodContaining('month', today)
  if (dayGap(thisMonth.first, today) < HISTORY.monthlyOfferDays) candidates.push(previousPeriod(thisMonth))
  const thisWeek = periodContaining('week', today)
  if (dayGap(thisWeek.first, today) < HISTORY.weeklyOfferDays) candidates.push(previousPeriod(thisWeek))
  return candidates.find((p) => !seen.includes(p.key) && ridesIn(rides, p, timeZone).length > 0) ?? null
}
