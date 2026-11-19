// Starting from a place (not a dock): which dock to pick a bike up at. Ranks nearby docks with bikes by
// walking time plus an estimated ride to the destination, so a slightly farther dock in the right
// direction can win. Pure: estimates only (no routing requests).
import { RIDE } from '../config'
import { kNearest } from '../lib/geo'
import { canRent } from '../lib/stationState'
import { estimateBetween } from '../routing/estimates'
import type { LngLat, Station } from '../types'

export interface PickupOption {
  station: Station
  /** Estimated walking seconds / meters from the start to this dock. */
  walkS: number
  walkM: number
  /** walk + estimated ride to the destination (or just the walk without a destination). */
  score: number
}

/**
 * `electric`: ride estimates at e-bike speed. `wantEbikes`: the rider prefers e-bikes in a mixed fleet, so a
 * dock without enough e-bikes for the party ranks lower (but is still offered: a classic bike nearby can beat
 * a long walk to an e-bike).
 */
export function pickupOptions(origin: LngLat, destination: LngLat | null, stations: readonly Station[], partySize = 1, max: number = RIDE.pickupCandidates, electric = false, wantEbikes = false): PickupOption[] {
  const usable = stations.filter((s) => canRent(s, partySize))
  const near = kNearest(origin, usable, (s) => s.coord, 12, RIDE.pickupWalkMeters)
  const pool = near.length ? near : kNearest(origin, usable, (s) => s.coord, max)
  return pool
    .map(({ item }) => {
      const walk = estimateBetween(origin, item.coord, 'walk')
      const ride = destination ? estimateBetween(item.coord, destination, 'bike', electric ? 'electric' : 'classic').duration : 0
      // A dock with only a couple of bikes is a gamble by the time you walk there.
      const low = (item.status?.bikes ?? 0) - (partySize - 1) <= RIDE.pickupLowBikes ? RIDE.pickupLowBikesPenaltyS : 0
      const noEbike = wantEbikes && (item.status?.ebikes ?? 0) < partySize ? RIDE.pickupNoEbikePenaltyS : 0
      return { station: item, walkS: walk.duration, walkM: walk.distance, score: walk.duration + ride + low + noEbike }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
}
