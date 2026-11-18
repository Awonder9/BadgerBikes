// Everything derived from the ride store + live stations: docks along the chosen route, the chosen stops,
// the Google Maps links and the rider's pass. Shared by the planner panel and the ride-in-progress banner.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { buildPolylineIndex, haversine, pointAlong } from '../../lib/geo'
import { fleetComposition } from '../../lib/stationState'
import { guidePoints, rideLinks, trailRangesOf, type RideLink } from '../../ride/googleMaps'
import { docksAlong, useRideStore } from '../../ride/rideStore'
import { rideSegments, type RouteDock } from '../../ride/stationsAlongRoute'
import { useAppStore } from '../../store/appStore'
import type { Station } from '../../types'

/** Destination farther than this from the end dock gets a separate walking link. */
const WALK_LINK_MIN_METERS = 60

/** Minutes included per ride for the rider's pass (their choice, else the system's default), or null. */
export function useIncludedMinutes(): number | null {
  const { systemId, pass } = useAppStore(useShallow((s) => ({ systemId: s.systemId, pass: s.systemId ? s.settings.passBySystem[s.systemId] : undefined })))
  const { details } = useSystemDetails(systemId)
  return pass ? pass.includedMinutes : (details?.defaultIncludedMinutes ?? null)
}

export interface RidePlan {
  start: Station | undefined
  /** Docks offered along the chosen route, in ride order. */
  along: RouteDock[]
  /** The ones the rider keeps (the last ends the ride). */
  chosen: RouteDock[]
  end: RouteDock | undefined
  /** Google Maps bicycling parts, then the optional walk. */
  rideParts: RideLink[]
  walkLink: RideLink | undefined
  /** First ride part not opened yet (index into rideParts), or null when all are opened. */
  nextPart: number | null
  hasViaPoints: boolean
  electric: boolean
  includedMinutes: number | null
  segments: ReturnType<typeof rideSegments>
}

export function useRidePlan(): RidePlan {
  const { systemId, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize })))
  const ride = useRideStore(useShallow((s) => ({ startId: s.startId, destination: s.destination, route: s.route, stopIds: s.stopIds, openedParts: s.openedParts })))
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const includedMinutes = useIncludedMinutes()
  const start = ride.startId ? snapshot?.byId.get(ride.startId) : undefined
  const dest = ride.destination
  const along = useMemo(() => (ride.route && snapshot && start && dest ? docksAlong(ride.route, snapshot, start.id, dest, partySize) : []), [ride.route, snapshot, start, dest, partySize])
  const chosen = along.filter((s) => ride.stopIds.includes(s.station.id))
  const end = chosen.at(-1)
  const electric = snapshot ? fleetComposition(snapshot.stations) === 'electric' : false
  const segments = start ? rideSegments(start.id, chosen, includedMinutes, electric) : []
  const walkTo = dest && end && haversine(end.station.coord, dest.coord) > WALK_LINK_MIN_METERS ? dest.coord : null
  // Keep Google Maps on the chosen route: docks are sent as points on the line, plus via points so no
  // stretch is long enough for Google to pick its own streets.
  const routeIndex = ride.route ? buildPolylineIndex(ride.route.geometry) : null
  const guide =
    ride.route && routeIndex && end
      ? guidePoints(
          chosen.map((s) => ({ coord: s.station.coord, along: s.along, offset: s.offset, name: s.station.name })),
          (a) => pointAlong(routeIndex, a).point,
          trailRangesOf(ride.route.maneuvers, routeIndex.cum),
        )
      : []
  const links = start && end ? rideLinks(start.coord, guide, walkTo) : []
  const rideParts = links.filter((l) => l.kind === 'ride')
  const nextIdx = rideParts.findIndex((_, i) => !ride.openedParts.includes(i))
  return {
    start,
    along,
    chosen,
    end,
    rideParts,
    walkLink: links.find((l) => l.kind === 'walk'),
    nextPart: nextIdx >= 0 ? nextIdx : null,
    hasViaPoints: guide.some((p) => !p.isStop),
    electric,
    includedMinutes,
    segments,
  }
}
