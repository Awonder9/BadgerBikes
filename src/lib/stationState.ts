// Shared station classification: map colors, StationCard, planner eligibility and availability alerts
// all use these functions so they can never disagree. BCycle publishes no capacity, so thresholds are
// absolute counts, not percentages.
import { AVAILABILITY } from '../config'
import type { AvailabilityState, MapMode, Station } from '../types'

export interface StationAvailability {
  bikeState: AvailabilityState
  dockState: AvailabilityState
  /** null when the feed has no bike-type breakdown. */
  ebikeState: AvailabilityState | null
}

/** 'none' at 0, 'low' at ≤ threshold (raised by party size − 1), else 'ok'. */
export function classifyCount(count: number, partySize = 1): 'ok' | 'low' | 'none' {
  if (count <= 0) return 'none'
  if (count < partySize || count <= AVAILABILITY.lowCountThreshold + (partySize - 1)) return 'low'
  return 'ok'
}

export function classifyStation(station: Station, partySize = 1): StationAvailability {
  const s = station.status
  if (!s || !s.isInstalled) return { bikeState: 'unavailable', dockState: 'unavailable', ebikeState: s?.ebikes == null ? null : 'unavailable' }
  const bikeState = s.isRenting ? classifyCount(s.bikes, partySize) : 'unavailable'
  const dockState = s.isReturning ? classifyCount(s.docks, partySize) : 'unavailable'
  const ebikeState = s.ebikes === null ? null : s.isRenting ? classifyCount(s.ebikes, partySize) : 'unavailable'
  return { bikeState, dockState, ebikeState }
}

export function stateForMode(station: Station, mode: MapMode, partySize = 1): AvailabilityState {
  const a = classifyStation(station, partySize)
  return mode === 'bikes' ? a.bikeState : a.dockState
}

/** A party of `partySize` can rent here right now. */
export function canRent(station: Station, partySize = 1): boolean {
  const s = station.status
  return !!s && s.isInstalled && s.isRenting && s.bikes >= partySize
}

/** A party of `partySize` can return bikes here right now. */
export function canReturn(station: Station, partySize = 1): boolean {
  const s = station.status
  return !!s && s.isInstalled && s.isReturning && s.docks >= partySize
}

export type FleetComposition = 'electric' | 'classic' | 'mixed' | 'unknown'

/**
 * Fleet makeup from currently docked bikes. Single-type fleets hide the classic/e-bike split and the
 * bike-type preference (14 of 25 BCycle systems are all-electric).
 */
export function fleetComposition(stations: readonly Station[]): FleetComposition {
  let classic = 0
  let electric = 0
  let typed = false
  for (const st of stations) {
    const s = st.status
    if (!s || s.ebikes === null || s.classic === null) continue
    typed = true
    classic += s.classic
    electric += s.ebikes
  }
  if (!typed || classic + electric === 0) return 'unknown'
  if (classic === 0) return 'electric'
  if (electric === 0) return 'classic'
  return 'mixed'
}
