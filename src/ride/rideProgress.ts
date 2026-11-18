// Pure helpers for a ride in progress: the BCycle ride timer against the pass's included minutes, the
// end dock's state, and nearby replacement docks. No React, no browser globals.
import { RIDE } from '../config'
import { haversine } from '../lib/geo'
import type { LngLat, Station } from '../types'

export type TimerState = 'ok' | 'warn' | 'over'

export interface RideTimer {
  elapsedS: number
  /** Seconds left of the included time, or null without a known pass limit. */
  leftS: number | null
  state: TimerState
}

export function rideTimer(startedAtMs: number, nowMs: number, includedMinutes: number | null): RideTimer {
  const elapsedS = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  if (!includedMinutes) return { elapsedS, leftS: null, state: 'ok' }
  const leftS = includedMinutes * 60 - elapsedS
  return { elapsedS, leftS, state: leftS <= 0 ? 'over' : leftS <= RIDE.timerWarnMinutes * 60 ? 'warn' : 'ok' }
}

export const clock = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`

export type EndDockState = 'ok' | 'low' | 'full'

export function endDockState(st: Station | undefined, partySize: number): EndDockState {
  const docks = st?.status?.docks ?? 0
  if (!st?.status?.isReturning || docks < partySize) return 'full'
  return docks <= RIDE.endDockLowDocks + (partySize - 1) ? 'low' : 'ok'
}

/** Nearby docks with space for the party, closest to `near` first (excluding the end dock). */
export function replacementDocks(stations: readonly Station[], endId: string, near: LngLat, partySize: number, max = 2): Array<{ station: Station; meters: number }> {
  return stations
    .filter((s) => s.id !== endId && !!s.status?.isInstalled && !!s.status.isReturning && (s.status.docks ?? 0) >= partySize + 1)
    .map((s) => ({ station: s, meters: haversine(near, s.coord) }))
    .filter((x) => x.meters <= RIDE.replacementRadiusMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, max)
}

