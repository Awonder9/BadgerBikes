// The lines drawn for a planned ride: the chosen route up to the end dock (with a routed last stretch when that
// dock is off the line — say the one closest to a far destination), and the walks before and after the ride,
// routed along streets once those load (straight lines until then, or when they can't be routed).
import { useMemo } from 'react'
import { RIDE } from '../../config'
import { useLegRoute, type LegRequest } from '../../data/legRoutes'
import { buildPolylineIndex, nearestOnPolyline, pointAlong } from '../../lib/geo'
import { rideTrack, sliceRoute } from '../../ride/gpx'
import { useRideStore } from '../../ride/rideStore'
import type { LngLat, RouteLeg } from '../../types'
import type { RidePlan } from './useRidePlan'

export interface RideLines {
  /** The chosen route up to the end dock, or the whole route until the docks are known; null without a route. */
  track: LngLat[] | null
  /** The routed last stretch to an off-route end dock, once loaded (the GPX file uses it too). */
  tail: LngLat[] | undefined
  /** Walks: starting place → pickup dock, end dock → destination. */
  walks: LngLat[][]
  /** The other route options (`others`), each up to where it passes closest to the end dock (whole until known). */
  others: LngLat[][]
}

export function useRideLines(systemId: string | null, plan: RidePlan, route: RouteLeg | null, otherRoutes: readonly RouteLeg[] = []): RideLines {
  const destination = useRideStore((s) => s.destination)
  const { end, start, origin } = plan
  const fromPlace = origin && !origin.stationId ? origin.coord : null
  // By value: station polls hand out new objects for the same docks, which must not redraw the lines.
  const endCoord = end?.station.coord
  const endAlong = end?.along
  const endOff = end !== undefined && end.offset > RIDE.offRouteTailMeters

  // The ride's last stretch: from the route's point nearest an off-route end dock to the dock.
  const tailFrom = useMemo(() => (route && endOff && endAlong !== undefined ? pointAlong(buildPolylineIndex(route.geometry), endAlong).point : null), [route, endOff, endAlong])
  const tailReq: LegRequest | null = tailFrom && endCoord ? { role: 'ride', mode: 'bike', from: tailFrom, to: endCoord } : null
  const tail = useLegRoute(systemId, tailReq)

  // Walks long enough to get their own Google link (shorter ones stay straight).
  const toDockReq: LegRequest | null = fromPlace && start && plan.walkToDock ? { role: 'toPickup', mode: 'walk', from: fromPlace, to: start.coord, fromIsUserPoint: true } : null
  const fromDockReq: LegRequest | null =
    route && endCoord && destination && plan.walkFromDock ? { role: 'toDestination', mode: 'walk', from: endCoord, to: destination.coord, toIsUserPoint: destination.kind !== 'station' } : null
  const toDock = useLegRoute(systemId, toDockReq)
  const fromDock = useLegRoute(systemId, fromDockReq)

  const endKey = endCoord && endAlong !== undefined ? `${endCoord.join()}|${endAlong}` : ''
  const track = useMemo(
    () => (route ? rideTrack(route.geometry, endCoord && endAlong !== undefined ? { coord: endCoord, along: endAlong } : undefined, tail) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the end dock by value (endKey)
    [route, endKey, tail],
  )
  const others = useMemo(
    () =>
      otherRoutes.map((r) => {
        if (!endCoord) return r.geometry
        const snap = nearestOnPolyline(buildPolylineIndex(r.geometry), endCoord)
        return snap ? sliceRoute(r.geometry, snap.distanceAlong) : r.geometry
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the end dock by value (endKey)
    [otherRoutes, endKey],
  )
  const startCoord = start?.coord
  const destCoord = destination?.coord
  const walks = useMemo(() => {
    const out: LngLat[][] = []
    if (fromPlace && startCoord) out.push(toDock ?? [fromPlace, startCoord])
    if (route && endCoord && destCoord) out.push(fromDock ?? [endCoord, destCoord])
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- coordinates by value
  }, [fromPlace?.join(), startCoord?.join(), route, endCoord?.join(), destCoord?.join(), toDock, fromDock])
  return { track, tail, walks, others }
}
