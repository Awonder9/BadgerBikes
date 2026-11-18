// Everything derived from the ride store + live stations: docks along the chosen route, the chosen stops,
// the Google Maps links and the rider's pass. Shared by the planner panel and the ride-in-progress banner.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { buildPolylineIndex, haversine, pointAlong } from '../../lib/geo'
import { fleetComposition } from '../../lib/stationState'
import { RIDE } from '../../config'
import { estimateBetween } from '../../routing/estimates'
import { directionsUrl, guidePoints, rideLinks, trailRangesOf, type RideLink } from '../../ride/googleMaps'
import { pickupOptions, type PickupOption } from '../../ride/pickup'
import { docksAlong, optimizedFor, routePace, useRideStore } from '../../ride/rideStore'
import { rideSeconds, rideSegments, type RouteDock } from '../../ride/stationsAlongRoute'
import { useAppStore } from '../../store/appStore'
import type { Place, Station } from '../../types'

/** Destination farther than this from the end dock gets a separate walking link. */
const WALK_LINK_MIN_METERS = RIDE.walkLinkMinMeters

export interface WalkLeg {
  /** Estimated seconds / meters (straight line × detour factor at walking speed). */
  seconds: number
  meters: number
  url: string
}

const walkLeg = (from: Place['coord'], to: Place['coord']): WalkLeg => {
  const e = estimateBetween(from, to, 'walk')
  return { seconds: e.duration, meters: e.distance, url: directionsUrl(from, to, 'walking') }
}

/** Minutes included per ride for the rider's pass (their choice, else the system's default), or null. */
export function useIncludedMinutes(): number | null {
  const { systemId, pass } = useAppStore(useShallow((s) => ({ systemId: s.systemId, pass: s.systemId ? s.settings.passBySystem[s.systemId] : undefined })))
  const { details } = useSystemDetails(systemId)
  return pass ? pass.includedMinutes : (details?.defaultIncludedMinutes ?? null)
}

export interface RidePlan {
  /** Where the rider starts (a place, or the start dock). */
  origin: Place | null
  start: Station | undefined
  /** Walk from the starting place to the pickup dock (null when starting at the dock). */
  walkToDock: WalkLeg | null
  /** Other pickup docks near the starting place (best first), when starting from a place. */
  pickups: PickupOption[]
  /** Walk from the end dock to the destination (null when it's right there). */
  walkFromDock: WalkLeg | null
  /** Estimated riding seconds from the pickup to the end dock. */
  rideSeconds: number | null
  /** Whole trip: walk + ride + walk, seconds. */
  totalSeconds: number | null
  /** Walking the whole way instead (estimate), from the starting place. */
  walkAll: WalkLeg | null
  /** Docks offered along the chosen route, in ride order. */
  along: RouteDock[]
  /** The fewest docks that keep every ride within the rider's max ride time (preselected). */
  optimizedIds: ReadonlySet<string>
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
  /** Seconds per meter of the chosen route (matches its card), when known. */
  pace: number | undefined
  includedMinutes: number | null
  /** settings.maxRideMinutes (0 = unlimited) */
  maxRideMinutes: number
  segments: ReturnType<typeof rideSegments>
}

export function useRidePlan(): RidePlan {
  const { systemId, partySize, maxRideMinutes } = useAppStore(useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize, maxRideMinutes: s.settings.maxRideMinutes })))
  const ride = useRideStore(useShallow((s) => ({ origin: s.origin, startId: s.startId, destination: s.destination, route: s.route, stopIds: s.stopIds, openedParts: s.openedParts })))
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const includedMinutes = useIncludedMinutes()
  const start = ride.startId ? snapshot?.byId.get(ride.startId) : undefined
  const dest = ride.destination
  // maxRideMinutes is read inside docksAlong (re-dock options), so it must invalidate this too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const along = useMemo(() => (ride.route && snapshot && start && dest ? docksAlong(ride.route, snapshot, start.id, dest, partySize) : []), [ride.route, snapshot, start, dest, partySize, maxRideMinutes])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- maxRideMinutes is read inside optimizedFor
  const optimizedIds = useMemo(() => new Set(snapshot && dest && ride.route ? optimizedFor(along, ride.route, snapshot, dest, partySize) : []), [along, ride.route, snapshot, dest, partySize, maxRideMinutes])
  const chosen = along.filter((s) => ride.stopIds.includes(s.station.id))
  const end = chosen.at(-1)
  const electric = snapshot ? fleetComposition(snapshot.stations) === 'electric' : false
  const pace = ride.route ? routePace(ride.route) : undefined
  const segments = start ? rideSegments(start.id, chosen, maxRideMinutes > 0 ? maxRideMinutes : null, electric, pace) : []
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
  const origin = ride.origin
  const fromPlace = origin && !origin.stationId ? origin : null
  const walkToDock = fromPlace && start && haversine(fromPlace.coord, start.coord) > WALK_LINK_MIN_METERS ? walkLeg(fromPlace.coord, start.coord) : null
  const pickups = useMemo(
    () => (fromPlace && snapshot ? pickupOptions(fromPlace.coord, dest?.coord ?? null, snapshot.stations, partySize, RIDE.pickupCandidates, electric) : []),
    [fromPlace, dest, snapshot, partySize, electric],
  )
  const walkFromDock = walkTo && end ? walkLeg(end.station.coord, walkTo) : null
  const rideS = end ? rideSeconds(end.along + end.offset, electric, pace) : null
  const totalSeconds = rideS !== null ? (walkToDock?.seconds ?? 0) + rideS + (walkFromDock?.seconds ?? 0) : null
  const startPoint = fromPlace?.coord ?? start?.coord
  const walkAll = startPoint && dest ? walkLeg(startPoint, dest.coord) : null
  const nextIdx = rideParts.findIndex((_, i) => !ride.openedParts.includes(i))
  return {
    origin,
    start,
    walkToDock,
    pickups,
    walkFromDock,
    rideSeconds: rideS,
    totalSeconds,
    walkAll,
    along,
    optimizedIds,
    chosen,
    end,
    rideParts,
    walkLink: links.find((l) => l.kind === 'walk'),
    nextPart: nextIdx >= 0 ? nextIdx : null,
    hasViaPoints: guide.some((p) => !p.isStop),
    electric,
    pace,
    includedMinutes,
    maxRideMinutes,
    segments,
  }
}
