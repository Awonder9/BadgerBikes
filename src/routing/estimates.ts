// Straight-line travel-time estimates — the same speed model as routing (SPEEDS), used for matrix
// fallbacks, StationCard "~6 min walk" hints and availability-watch replacement ranking.
import { SPEEDS } from '../config'
import { haversine } from '../lib/geo'
import type { BikeKind } from '../routing/types'
import type { LngLat, TravelMode } from '../types'

export function speedMps(mode: TravelMode, bikeKind: BikeKind = 'classic'): number {
  return (mode === 'walk' ? SPEEDS.walkKph : SPEEDS.bikeKph[bikeKind]) / 3.6
}

/** Street-network distance estimate from a straight-line distance. */
export function estimateNetworkMeters(straightMeters: number): number {
  return straightMeters * SPEEDS.detourFactor
}

/** Estimated seconds to cover `straightMeters` (straight-line) by `mode`. */
export function estimateSeconds(straightMeters: number, mode: TravelMode, bikeKind: BikeKind = 'classic'): number {
  return estimateNetworkMeters(straightMeters) / speedMps(mode, bikeKind)
}

export function estimateBetween(a: LngLat, b: LngLat, mode: TravelMode, bikeKind: BikeKind = 'classic'): { duration: number; distance: number } {
  const straight = haversine(a, b)
  return { duration: estimateSeconds(straight, mode, bikeKind), distance: estimateNetworkMeters(straight) }
}
