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
}

export type RecorderStep =
  | { kind: 'none' }
  | { kind: 'update'; id: string; fields: RideFields }
  /** Ends `close` (the previous plan's record) when set, then starts `ride`. */
  | { kind: 'start'; ride: RideRecord; planKey: string; close: ReturnType<typeof rideEnd> | 'none' }
  | { kind: 'close'; end: ReturnType<typeof rideEnd> }

export function recorderStep(active: { record: RideRecord; planKey: string } | null, input: RecorderInput, nowMs: number, newId: (startedAtMs: number) => string): RecorderStep {
  if (input.underWay && input.startedAtMs !== null && input.plan) {
    if (active?.planKey === input.plan.key) return { kind: 'update', id: active.record.id, fields: input.plan.fields }
    // Another plan while riding (the next leg of a trip, ridden on): the last record ends now and this one starts —
    // now, unless the timer restarted since (a new BCycle ride).
    const startedAtMs = active && input.startedAtMs <= active.record.startedAtMs ? nowMs : input.startedAtMs
    return {
      kind: 'start',
      ride: { id: newId(startedAtMs), startedAtMs, endedAtMs: null, endEstimated: false, stravaActivityId: null, ...input.plan.fields },
      planKey: input.plan.key,
      close: active ? rideEnd(active.record.startedAtMs, active.record.plannedS, nowMs, true) : 'none',
    }
  }
  if (!input.underWay && active) return { kind: 'close', end: rideEnd(active.record.startedAtMs, active.record.plannedS, nowMs, input.seenUnderWay) }
  return { kind: 'none' }
}
