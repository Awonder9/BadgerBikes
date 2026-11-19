// The usage dashboard's numbers for the chosen range, from the server's days (GET /api/analytics). Pure.
import type { StatsDay, StatsResponse, UsageCounter, UsageEvent } from '../api/contract'

export type RangeDays = 7 | 30 | 90
export const RANGES: readonly RangeDays[] = [7, 30, 90]
/** Days the dashboard asks for: the longest range and the period before it (for "vs previous"). */
export const FETCH_DAYS = 180

export interface Share {
  key: string
  value: number
}

export interface RangeSummary {
  days: StatsDay[]
  /** Unique devices in the range, and in the range before it (null if the server had no counts yet). */
  users: number
  usersBefore: number | null
  today: number
  newUsers: number
  opens: number
  ridesStarted: number
  routes: number
  /** Device-days by city / platform / installed / language (each device once per day). */
  cities: Share[]
  platforms: Share[]
  installed: Share[]
  langs: Share[]
  /** Average devices with the app open, by hour of day. */
  hourly: number[]
  features: Share[]
}

const usersIn = (d: StatsDay, range: RangeDays) => (range === 7 ? d.users7 : range === 30 ? d.users30 : d.users90)

function total(days: readonly StatsDay[], pick: (d: StatsDay) => Partial<Record<string, number>>): Share[] {
  const sums = new Map<string, number>()
  for (const d of days) for (const [k, v] of Object.entries(pick(d))) sums.set(k, (sums.get(k) ?? 0) + (v ?? 0))
  return [...sums].map(([key, value]) => ({ key, value })).filter((s) => s.value > 0).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
}

const count = (days: readonly StatsDay[], name: UsageEvent | UsageCounter) => days.reduce((n, d) => n + (d.counts[name] ?? 0), 0)

/** Ranked shares with the tail past `keep` folded into one "other" row. */
export function foldTail(shares: readonly Share[], keep: number): Share[] {
  if (shares.length <= keep + 1) return [...shares]
  const other = shares.slice(keep).reduce((n, s) => n + s.value, 0)
  return [...shares.slice(0, keep), { key: 'other', value: other }]
}

/** The features riders use, in a fixed order (zeros included, so a feature nobody uses still shows). */
export const FEATURES: ReadonlyArray<UsageEvent | UsageCounter> = ['nearest_dock', 'directions', 'share', 'gpx', 'alerts_on', 'alerts_sent', 'routes_busy']

export function summarizeRange(stats: StatsResponse, range: RangeDays): RangeSummary {
  const all = stats.days
  const days = all.slice(-range)
  const last = all.at(-1)
  const before = all.length > range ? all[all.length - 1 - range] : undefined
  // "vs previous" only when counting had begun before the previous period ended.
  const counted = stats.since !== null && before !== undefined && stats.since <= before.day
  const deviceDays = days.reduce((n, d) => n + d.users, 0)
  const installed = days.reduce((n, d) => n + d.installed, 0)
  const hourly = Array.from({ length: 24 }, (_, h) => days.reduce((n, d) => n + (d.beats[h] ?? 0), 0) / (12 * Math.max(days.length, 1)))
  return {
    days,
    users: last ? usersIn(last, range) : 0,
    usersBefore: counted && before ? usersIn(before, range) : null,
    today: last?.users ?? 0,
    newUsers: days.reduce((n, d) => n + d.newUsers, 0),
    opens: days.reduce((n, d) => n + d.opens, 0),
    ridesStarted: count(days, 'ride_start'),
    routes: count(days, 'routes'),
    cities: total(days, (d) => d.cities),
    platforms: total(days, (d) => d.platforms),
    installed: deviceDays > 0 ? [{ key: 'installed', value: installed }, { key: 'browser', value: deviceDays - installed }] : [],
    langs: total(days, (d) => d.langs),
    hourly,
    features: FEATURES.map((key) => ({ key, value: count(days, key) })),
  }
}

/** Relative change, e.g. 0.12 for +12%; null when there is nothing to compare with. */
export function change(now: number, before: number | null): number | null {
  if (before === null || before === 0) return null
  return (now - before) / before
}

/** Round, readable axis ticks from 0 to at least `max`. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow) || 1
  const ticks: number[] = []
  for (let v = 0; v < max + step * 0.5 && ticks.length < 12; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  if ((ticks.at(-1) ?? 0) < max) ticks.push(Math.round((ticks.length * step) * 1e6) / 1e6)
  return ticks
}

const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
/** 1,284 · 2.5 · 12.9K */
export const formatCount = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : plain.format(n))

