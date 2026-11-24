// What the ride recorder (src/ui/ride/RideRecorder.tsx) does on each change of the ride plan: start a record, follow
// the plan, or end it. Pure: no stores, no clock (both passed in).
import { rideEnd, type RideRecord } from './rides'

/** Everything a record copies from the plan (all but its identity, times and Strava link). */
export type RideFields = Omit<RideRecord, 'id' | 'startedAtMs' | 'endedAtMs' | 'endEstimated' | 'stravaActivityId'>

export interface RecorderInput {
  /** A BCycle ride is under way (a link opened, or the timer running). */
  underWay: boolean
  /** The ride timer's start, ms (null: walking to the dock, or no ride). */
  startedAtMs: number | null
  /** The plan being ridden and what to record of it; null while it isn't known yet (stations still loading). */
  plan: { key: string; fields: RideFields } | null
  /** The ride was seen under way in this page: when it stops now, the rider ended it here. */
  seenUnderWay: boolean
  /**
   * The rider set off on this plan: a Google Maps link (or the GPX file) of it opened, or a bike unlocked for it (its
   * timer started here, not carried over from before the plan — a bike kept from a trip's last leg, or "I'm already on
   * a bike").
   */
  setOff: boolean
}

/** The record being written, and the plan it follows (`ridden`: the rider set off on that plan). */
export interface ActiveRecord {
  record: RideRecord
  planKey: string
  ridden: boolean
}

export type RecorderStep =
  | { kind: 'none' }
  /** The record follows `planKey` (the same plan, updated — or a new one replacing a plan never set off on). */
  | { kind: 'update'; id: string; fields: RideFields; planKey: string; ridden: boolean }
  /** Ends `close` (the previous plan's record) when set, then starts `ride`. */
  | { kind: 'start'; ride: RideRecord; planKey: string; ridden: boolean; close: ReturnType<typeof rideEnd> | 'none' }
  | { kind: 'close'; end: ReturnType<typeof rideEnd> }

/** Equal values, arrays and flat objects (highlights, meters per kind of way) compared one level deep. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

/** The record already says all of this (station polls re-run the recorder mid-ride with the same plan). */
const hasFields = (record: RideRecord, fields: RideFields): boolean => (Object.keys(fields) as Array<keyof RideFields>).every((k) => same(record[k], fields[k]))

export function recorderStep(active: ActiveRecord | null, input: RecorderInput, nowMs: number, newId: (startedAtMs: number) => string): RecorderStep {
  if (input.underWay && input.startedAtMs !== null && input.plan) {
    const { key, fields } = input.plan
    const ridden = !!active?.ridden || input.setOff
    if (active?.planKey === key) {
      // Nothing new: no write (each one saves the whole history to storage).
      if (hasFields(active.record, fields) && ridden === active.ridden) return { kind: 'none' }
      return { kind: 'update', id: active.record.id, fields, planKey: key, ridden }
    }
    // Another plan on the same running timer before the rider set off on the first ("I'm already on a bike", then
    // "Try another ride" or a new destination): it was only being planned — the record follows the new plan instead
    // of ending as a ride nobody rode.
    if (active && !active.ridden && input.startedAtMs === active.record.startedAtMs) return { kind: 'update', id: active.record.id, fields, planKey: key, ridden: input.setOff }
    // Another plan while riding (the next leg of a trip, ridden on): the last record ends now and this one starts —
    // now, unless the timer restarted since (a new BCycle ride).
    const startedAtMs = active && input.startedAtMs <= active.record.startedAtMs ? nowMs : input.startedAtMs
    return {
      kind: 'start',
      ride: { id: newId(startedAtMs), startedAtMs, endedAtMs: null, endEstimated: false, stravaActivityId: null, ...input.plan.fields },
      planKey: input.plan.key,
      ridden: input.setOff,
      close: active ? rideEnd(active.record.startedAtMs, active.record.plannedS, nowMs, true) : 'none',
    }
  }
  if (!input.underWay && active) return { kind: 'close', end: rideEnd(active.record.startedAtMs, active.record.plannedS, nowMs, input.seenUnderWay) }
  return { kind: 'none' }
}
