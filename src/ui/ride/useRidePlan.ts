// Everything derived from the ride store + live stations: docks along the chosen route, the chosen stops,
// the Google Maps links and the rider's pass. Shared by the planner panel and the ride-in-progress banner.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { buildPolylineIndex, haversine, pointAlong } from '../../lib/geo'
import { fleetComposition } from '../../lib/stationState'
import { BIKE_ROUTING, RIDE } from '../../config'
import { estimateBetween } from '../../routing/estimates'
import { directionsUrl, guidePoints, rideLinks, trailRangesOf, type Handoff, type RideLink } from '../../ride/googleMaps'
import { pickupOptions, type PickupOption } from '../../ride/pickup'
import { docksAlong, optimizedFor, routePace, useRideStore, rideActive } from '../../ride/rideStore'
import { rideSeconds, rideSegments, type RouteDock } from '../../ride/stationsAlongRoute'
import { useAppStore } from '../../store/appStore'
import type { Place, RouteLeg, Station, StationsSnapshot } from '../../types'

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

/**
 * Minutes included per ride for the rider's pass (their choice, else the system's default), or null.
 * `enabled` false: no system-details request just for this (cached details are still used).
 */
export function useIncludedMinutes(enabled = true): number | null {
  const { systemId, pass } = useAppStore(useShallow((s) => ({ systemId: s.systemId, pass: s.systemId ? s.settings.passBySystem[s.systemId] : undefined })))
  const { details } = useSystemDetails(systemId, enabled && !pass)
  return pass ? pass.includedMinutes : (details?.defaultIncludedMinutes ?? null)
}

/**
 * The docks along the current route, shared by every useRidePlan caller (map, planner, ride banner, alerts):
 * computed once per change of its inputs instead of once per caller. Inputs are compared by identity.
 */
let alongMemo: { args: readonly unknown[]; value: RouteDock[] } | null = null
function sharedDocksAlong(route: RouteLeg, snapshot: StationsSnapshot, startId: string, dest: Place, partySize: number, settings: { maxRideMinutes: number; preferEbikes: boolean }, keepIds: readonly string[]): RouteDock[] {
  const args = [route, snapshot, startId, dest, partySize, settings.maxRideMinutes, settings.preferEbikes, keepIds]
  if (alongMemo?.args.every((a, i) => a === args[i])) return alongMemo.value
  // docksAlong reads these settings from the store; they are part of the key so a change recomputes.
  const value = docksAlong(route, snapshot, startId, dest, partySize, keepIds)
  alongMemo = { args, value }
  return value
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
  /** Extra Google Maps stops (via points) in the links, beyond the docks. */
  viaCount: number
  /** How the chosen route option steers Google Maps (BIKE_ROUTING.options[].handoff). */
  handoff: Handoff
  electric: boolean
  /** Seconds per meter of the chosen route (matches its card), when known. */
  pace: number | undefined
  includedMinutes: number | null
  /** settings.maxRideMinutes (0 = unlimited) */
  maxRideMinutes: number
  segments: ReturnType<typeof rideSegments>
}

export function useRidePlan(): RidePlan {
  const { systemId, partySize, maxRideMinutes, preferEbikes } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize, maxRideMinutes: s.settings.maxRideMinutes, preferEbikes: s.settings.preferEbikes })),
  )
  const ride = useRideStore(
    useShallow((s) => ({ origin: s.origin, startId: s.startId, destination: s.destination, route: s.route, routeIndex: s.routeIndex, stopIds: s.stopIds, openedParts: s.openedParts, bikeAt: s.bikeAt, loop: s.loop !== null })),
  )
  // Faster polling only while it matters (planner open or a ride under way); this hook is also used by
  // always-mounted pieces (ride banner, alerts, map), which must not keep the app polling fast.
  const panelOpen = useAppStore((s) => s.panel === 'ride')
  const riding = useRideStore(rideActive)
  const { snapshot } = useStationsSnapshot(systemId, { active: panelOpen || riding })
  const includedMinutes = useIncludedMinutes(ride.route !== null)
  const route = ride.route
  const startId = ride.startId
  const start = startId ? snapshot?.byId.get(startId) : undefined
  const dest = ride.destination
  // The chosen stops stay listed even when their counts change, so a dock that fills up mid-ride is still
  // the end of the ride (and is reported as full) instead of silently disappearing from the plan.
  const along = useMemo(
    () =>
      route && snapshot && startId && snapshot.byId.has(startId) && dest
        ? sharedDocksAlong(route, snapshot, startId, dest, partySize, { maxRideMinutes, preferEbikes }, ride.stopIds)
        : [],
    [route, snapshot, startId, dest, partySize, maxRideMinutes, preferEbikes, ride.stopIds],
  )
  const optimizedIds = useMemo(
    () => new Set(snapshot && dest && route && startId ? optimizedFor(along, route, snapshot, dest, partySize, startId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maxRideMinutes and preferEbikes are read inside optimizedFor
    [along, route, snapshot, dest, partySize, startId, maxRideMinutes, preferEbikes],
  )
  const chosen = useMemo(() => along.filter((s) => ride.stopIds.includes(s.station.id)), [along, ride.stopIds])
  const end = chosen.at(-1)
  const fleet = useMemo(() => (snapshot ? fleetComposition(snapshot.stations) : 'unknown'), [snapshot])
  const electric = fleet === 'electric' || (preferEbikes && fleet === 'mixed')
  const pace = route ? routePace(route) : undefined
  const segments = useMemo(() => (startId ? rideSegments(startId, chosen, maxRideMinutes > 0 ? maxRideMinutes : null, electric, pace) : []), [startId, chosen, maxRideMinutes, electric, pace])
  const walkTo = dest && end && haversine(end.station.coord, dest.coord) > WALK_LINK_MIN_METERS ? dest.coord : null
  // Google Maps gets the docks (as points on the line), plus the route option's via points (googleMaps.ts).
  // "Just ride" has no destination for Google to aim at: it is held to the ride's shape ('loop').
  const handoff: Handoff = ride.loop ? 'loop' : (BIKE_ROUTING.options[ride.routeIndex]?.handoff ?? 'docks')
  const routeIndex = useMemo(() => (route ? buildPolylineIndex(route.geometry) : null), [route])
  const trailRanges = useMemo(() => (route && routeIndex ? trailRangesOf(route.maneuvers, routeIndex.cum) : []), [route, routeIndex])
  const guide = useMemo(
    () =>
      routeIndex && chosen.length > 0
        ? guidePoints(
            chosen.map((s) => ({ coord: s.station.coord, along: s.along, offset: s.offset, name: s.station.name })),
            (a) => pointAlong(routeIndex, a).point,
            trailRanges,
            handoff,
          )
        : [],
    [routeIndex, chosen, trailRanges, handoff],
  )
  // Already on a bike: the first link starts where the rider is (and isn't an unlock at a dock).
  const startCoord = ride.bikeAt ?? start?.coord
  const startIsDock = !ride.bikeAt
  const links = useMemo(() => (startCoord && guide.length > 0 ? rideLinks(startCoord, guide, walkTo, undefined, startIsDock) : []), [startCoord, guide, walkTo, startIsDock])
  const rideParts = useMemo(() => links.filter((l) => l.kind === 'ride'), [links])
  const origin = ride.origin
  const fromPlace = origin && !origin.stationId ? origin : null
  const walkToDock = fromPlace && start && haversine(fromPlace.coord, start.coord) > WALK_LINK_MIN_METERS ? walkLeg(fromPlace.coord, start.coord) : null
  const wantEbikes = preferEbikes && fleet === 'mixed'
  const pickups = useMemo(
    () => (fromPlace && snapshot ? pickupOptions(fromPlace.coord, dest?.coord ?? null, snapshot.stations, partySize, RIDE.pickupCandidates, electric, wantEbikes) : []),
    [fromPlace, dest, snapshot, partySize, electric, wantEbikes],
  )
  const walkFromDock = walkTo && end ? walkLeg(end.station.coord, walkTo) : null
  const rideS = end ? rideSeconds(end.along + end.offset, electric, pace) : null
  const totalSeconds = rideS !== null ? (walkToDock?.seconds ?? 0) + rideS + (walkFromDock?.seconds ?? 0) : null
  const startPoint = fromPlace?.coord ?? start?.coord
  // Walking "there" instead means nothing for a ride with no destination.
  const walkAll = startPoint && dest && !ride.loop ? walkLeg(startPoint, dest.coord) : null
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
    viaCount: guide.filter((p) => !p.isStop).length,
    handoff,
    electric,
    pace,
    includedMinutes,
    maxRideMinutes,
    segments,
  }
}
