// Usage Durable Object: one instance (USAGE_OBJECT) keeps the anonymous usage counts for the operator's
// dashboard. Stored: one record of counts per day (worker/usageCore.ts), the current check-in window and the
// all-time device total — no identifiers, IP addresses or locations. Days older than USAGE.keepDays are deleted.
import { DurableObject } from 'cloudflare:workers'
import type { StatsResponse, UsageCounter, UsageRequest } from '../src/api/contract'
import { USAGE } from '../src/config'
import { addDays, dayKey, hourOf, windowOf } from '../src/lib/usage'
import { applyUsage, countServer, emptyDay, summarize, type UsageDayRecord, type WindowState } from './usageCore'

/** idFromName of the single Usage instance. */
export const USAGE_OBJECT = 'usage'

const dayKeyOf = (day: string) => `d:${day}`
const WINDOW = 'window'
const TOTAL = 'total'
type Total = { allTime: number; since: string }
/** All-time dashboard views (each day's are in its record). */
const VIEWS = 'dashboardViews'

export class Usage extends DurableObject<Env> {
  /** Counts one report from the app. */
  async record(req: UsageRequest): Promise<void> {
    const now = Date.now()
    const today = dayKey(now, USAGE.timeZone)
    const stored = await this.ctx.storage.get<unknown>([dayKeyOf(today), WINDOW, TOTAL])
    const day = (stored.get(dayKeyOf(today)) as UsageDayRecord | undefined) ?? null
    const state = (stored.get(WINDOW) as WindowState | undefined) ?? null
    const total = (stored.get(TOTAL) as Total | undefined) ?? null
    const record = day ?? emptyDay()
    const result = applyUsage(record, state, req, { window: windowOf(now, USAGE.beatMs), hour: hourOf(now, USAGE.timeZone) })
    const writes: Record<string, unknown> = { [dayKeyOf(today)]: record }
    if (result.state !== state) writes[WINDOW] = result.state
    if (result.newDevice || !total) writes[TOTAL] = { allTime: (total?.allTime ?? 0) + (result.newDevice ? 1 : 0), since: total?.since ?? today } satisfies Total
    await this.ctx.storage.put(writes)
    if (!day) await this.prune(today)
  }

  /** Counts something the Worker saw itself (a route request, a delivered alert). */
  async count(name: UsageCounter): Promise<void> {
    const today = dayKey(Date.now(), USAGE.timeZone)
    const day = await this.ctx.storage.get<UsageDayRecord>(dayKeyOf(today))
    const record = day ?? emptyDay()
    countServer(record, name)
    const writes: Record<string, unknown> = { [dayKeyOf(today)]: record }
    if (name === 'dashboard_views') {
      const views = await this.ctx.storage.get<Total>(VIEWS)
      writes[VIEWS] = { allTime: (views?.allTime ?? 0) + 1, since: views?.since ?? today } satisfies Total
    }
    await this.ctx.storage.put(writes)
    if (!day) await this.prune(today)
  }

  /** The dashboard's numbers for the `days` days ending today. */
  async report(days: number): Promise<StatsResponse> {
    const now = Date.now()
    const today = dayKey(now, USAGE.timeZone)
    // The 90-day count of the first day shown needs the 89 days before it.
    const first = addDays(today, -(days - 1) - (USAGE.maxGapDays - 1))
    const listed = await this.ctx.storage.list<UsageDayRecord>({ start: dayKeyOf(first), end: dayKeyOf(addDays(today, 1)) })
    const records = new Map<string, UsageDayRecord>()
    for (const [key, value] of listed) records.set(key.slice(2), value)
    const stored = await this.ctx.storage.get<unknown>([WINDOW, TOTAL, VIEWS])
    const total = (stored.get(TOTAL) as Total | undefined) ?? null
    const views = (stored.get(VIEWS) as Total | undefined) ?? null
    return summarize(records, {
      today,
      days,
      nowMs: now,
      window: windowOf(now, USAGE.beatMs),
      state: (stored.get(WINDOW) as WindowState | undefined) ?? null,
      allTime: total?.allTime ?? 0,
      since: total?.since ?? null,
      dashboardViews: { allTime: views?.allTime ?? 0, since: views?.since ?? null },
    })
  }

  /** On a day's first record: deletes the days that are now older than USAGE.keepDays. */
  private async prune(today: string): Promise<void> {
    const old = [...(await this.ctx.storage.list({ prefix: 'd:', end: dayKeyOf(addDays(today, -USAGE.keepDays)) })).keys()]
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128))
  }
}
