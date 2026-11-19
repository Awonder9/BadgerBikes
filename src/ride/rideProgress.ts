// Pure helpers for a ride in progress: the BCycle ride timer against the pass's included minutes, the
// end dock's state, and nearby replacement docks. No React, no browser globals.
import { RIDE } from '../config'
import { haversine, kNearest } from '../lib/geo'
import { canReturn } from '../lib/stationState'
import type { LngLat, PassOption, Station } from '../types'

/**
 * Notification tags of the ride alerts, shared by the in-app alerts and the Worker's background pushes: a
 * notification replaces the one with the same tag instead of stacking up.
 */
export const ALERT_TAGS = { warn: 'ride-warn', over: 'ride-over', full: 'dock-full', low: 'dock-low' } as const

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

/** "Nearest open dock": the closest dock where the party can return bikes right now (any distance), or null. */
export function nearestOpenDock(stations: readonly Station[], from: LngLat, partySize: number): { station: Station; meters: number } | null {
  const best = kNearest(from, stations.filter((s) => canReturn(s, partySize)), (s) => s.coord, 1)[0]
  return best ? { station: best.item, meters: best.distance } : null
}

/** Asking for the rider's pass changes the ride timer only when the system's passes include different times. */
export function passChoiceMatters(passes: readonly PassOption[]): boolean {
  return new Set(passes.map((p) => p.includedMinutes)).size > 1
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

