// Ride planning state: start dock → destination, route options, the docks the rider stops at, and the
// progress of a ride handed off to Google Maps (parts opened, ride timer).
//
// Persisted on the device, because switching to Google Maps and back can reload the page: coming back for
// "Part 2" must find the same plan, not an empty planner. It stays saved until the rider opens the last
// Google Maps link (the walk, or the last ride part) or arrives at the destination (finishPlan).
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { api } from '../api/client'
import { APP, BIKE_ROUTING, LOOP, RIDE, SPEEDS } from '../config'
import { loadScenic } from '../data/scenic'
import { toAppError } from '../lib/errors'
import { buildPolylineIndex, haversine, isValidLngLat } from '../lib/geo'
import { loopTargetMeters, planLoop } from '../routing/loop'
import { routeHighlights, type Highlight } from '../routing/scenic'
import { safeStorage } from '../lib/storage'
import { ridesElectric } from '../lib/stationState'
import { validatePlace } from '../store/validate'
import type { LngLat, Place, RouteLeg, Station, StationsSnapshot } from '../types'
import { useAppStore } from '../store/appStore'
import { optimizedStops, routeDocks, type RouteDock } from './stationsAlongRoute'

/**
 * What went wrong with a route request; the planner shows each in the rider's language (RouteError). 'tooClose':
 * the destination is where the ride starts (no request is made).
 */
export type RideErrorKind = 'busy' | 'unroutable' | 'noRoute' | 'offline' | 'tooClose' | 'other'

/** "Just ride": a ride with no destination, of about `minutes`, back to the start dock or ending at another one. */
export interface LoopSettings {
  minutes: number
  /** End at the start dock (true) or at another dock with space (false). */
  roundTrip: boolean
  /** Picks the waypoints (src/routing/loop.ts); "Try another" changes it. */
  seed: number
  /** Trails and scenic places the routed ride passes (empty until routed, or without scenery data). */
  highlights: Highlight[]
  /** Asked for one way, but no dock with space was in range: the ride came back to the start instead. */
  fellBack: boolean
}

export interface RideState {
  /** Where the rider starts: a place (walk to the pickup dock first) or a dock (origin.stationId). */
  origin: Place | null
  /** Pickup dock (the ride starts here). */
  startId: string | null
  /** The rider chose the pickup dock themselves (otherwise it follows the best one for origin → destination). */
  pickupPinned: boolean
  /** The rider opened the walking link to the pickup dock. */
  walkToDockOpened: boolean
  destination: Place | null
  /** Route options in BIKE_ROUTING.options order (direct, bike-friendly) and the one shown/used. */
  routes: RouteLeg[]
  routeIndex: number
  route: RouteLeg | null
  status: 'idle' | 'routing' | 'ready' | 'error'
  error: { kind: RideErrorKind; message: string } | null
  /** Route option to select when routes arrive (from a share link). */
  pendingRouteIndex: number | null
  /** Chosen stops in route order (preselected; the rider unchecks ones they don't want). The last one ends the ride. */
  stopIds: string[]
  /** Google Maps parts the rider has opened (indices), for "Next: Part 2". */
  openedParts: number[]
  /** When the current BCycle ride started (the last part opened from a dock), epoch ms; null = not riding. */
  rideStartedAtMs: number | null
  /** settings.maxRideMinutes the current stops were optimized for (re-optimize only when it changes). */
  stopsForMaxRide: number | null
  /** The rider opened the last link or arrived: the plan stays usable now but is no longer saved. */
  finished: boolean
  /**
   * A multi-stop trip's leg ridden on the bike kept from the previous leg (tripStore.completeLeg): that BCycle
   * ride goes on, so its timer carries over — re-routing, another route option or a new destination keep it, and
   * opening the leg's first link (which starts at a dock) doesn't restart it.
   */
  continuingRide: boolean
  /**
   * When the rider said they docked along the way and took a bike again (redockAlongWay), epoch ms; the timer
   * restarted then. Cleared once a link is opened (see markPartOpened), on undo, or when the ride ends.
   */
  redockedAtMs: number | null
  /**
   * The rider is already on a bike here (startOnBike): routes and the first Google Maps link start from this point,
   * not the start dock — which is then only the dock nearest it — and the ride timer runs (continuingRide).
   */
  bikeAt: LngLat | null
  /**
   * A multi-stop trip's legs finished before this one, as their drawn lines (tripStore.completeLeg), so the map can
   * show where the rider has been in one muted color. Kept until the plan is cleared or another leg is chosen.
   */
  pastLegs: LngLat[][]
  /**
   * "Just ride" (no destination): the loop's settings, or null for an ordinary plan. The destination is filled in
   * once the ride is routed (loadLoopRoute): the start dock for a loop back, else the dock the ride ends at.
   */
  loop: LoopSettings | null
  /** Plan a ride with no destination from the current start (replaces the destination; keeps a kept bike's timer). */
  startLoop(settings: { minutes: number; roundTrip: boolean }): void
  /** Another ride with the same settings (a different seed). */
  shuffleLoop(): void
  /** Start from a place or a dock (a dock is also the pickup); null clears the start. */
  setOrigin(place: Place | null): void
  /**
   * "I'm already on a bike": plan from `at` with the ride timer started at `startedAtMs` (when the bike was unlocked).
   * `dock` is the dock nearest `at`, kept as the plan's start dock.
   */
  startOnBike(at: LngLat, dock: Place, startedAtMs: number): void
  /** Pick up at this dock (pins it); null clears the start entirely. */
  setStart(id: string | null): void
  /** The best pickup for the current origin (not pinned). */
  autoPickup(id: string): void
  setDestination(place: Place | null): void
  /** One leg of a multi-stop trip (tripStore.ts): its start and destination at once, as a fresh plan. */
  planLeg(leg: { origin: Place | null; startId: string | null; pickupPinned: boolean; destination: Place }): void
  toggleStop(id: string, routeOrder: readonly string[]): void
  /** The rider opened Google Maps part `index`; `fromDock` = it starts where they unlock a bike. */
  markPartOpened(index: number, fromDock: boolean, startTimer?: boolean): void
  openWalkToDock(): void
  /** "I've unlocked a bike": starts the ride timer now. */
  startRideTimer(): void
  /**
   * "Docked along the way": the rider docked at a dock the plan didn't stop at (say, on the bike kept from an
   * earlier leg) and took a bike again — a new BCycle ride, so the timer restarts now. Nothing else changes: the
   * leg, its opened links, the trip. Only while a timer runs; returns the previous start (for undo), or null.
   */
  redockAlongWay(nowMs?: number): number | null
  /** Undo of redockAlongWay: back to the timer's previous start. */
  undoRedock(previousStartMs: number): void
  /** "I'm done": clears progress but keeps the plan. */
  endRide(): void
  /** Stop saving this plan on the device (last link opened, or arrived). */
  finishPlan(): void
  reset(): void
}

/**
 * A BCycle ride is under way: a Google Maps part was opened, or the timer started ("I've unlocked a bike").
 * A new plan would clear its timer and alerts, so nothing does that behind the rider's back meanwhile.
 */
export const rideUnderWay = (s: Pick<RideState, 'openedParts' | 'rideStartedAtMs'>): boolean => s.openedParts.length > 0 || s.rideStartedAtMs !== null

/**
 * The ride card, banner, alerts and live counts are on: a link was opened (or the walk to the dock), or the rider
 * is on the bike kept from the previous leg of a trip (its timer runs before this leg's first link is opened).
 */
export const rideActive = (s: Pick<RideState, 'openedParts' | 'walkToDockOpened' | 'continuingRide' | 'rideStartedAtMs'>): boolean =>
  s.openedParts.length > 0 || s.walkToDockOpened || (s.continuingRide && s.rideStartedAtMs !== null)

/**
 * Another route option can't be chosen now: it would throw away the ride under way — its opened links and, unless
 * the rider is on a bike kept from before this plan (continuingRide, whose timer chooseRoute keeps), the ride timer
 * and its alerts. A stray tap on the other option mid-ride used to do exactly that. Ending the ride unlocks it.
 */
export const routeChoiceLocked = (s: Pick<RideState, 'openedParts' | 'rideStartedAtMs' | 'continuingRide'>): boolean =>
  s.openedParts.length > 0 || (s.rideStartedAtMs !== null && !s.continuingRide)

let inflight: AbortController | null = null

/** Drops a route request for the previous start/destination, so its late answer can't come back as the plan. */
function abortRouting(): void {
  inflight?.abort()
  inflight = null
}

const planReset = (): Partial<RideState> => {
  abortRouting()
  return { routes: [], route: null, stopIds: [], status: 'idle', error: null, openedParts: [], rideStartedAtMs: null, walkToDockOpened: false, continuingRide: false, redockedAtMs: null, bikeAt: null }
}

/** What a fresh plan keeps of a ride carried over from the previous leg: its timer. */
const carried = (s: Pick<RideState, 'continuingRide' | 'rideStartedAtMs' | 'bikeAt'>): Partial<RideState> =>
  s.continuingRide && s.rideStartedAtMs !== null ? { continuingRide: true, rideStartedAtMs: s.rideStartedAtMs, bikeAt: s.bikeAt } : {}

type RideActions = 'startLoop' | 'shuffleLoop' | 'setOrigin' | 'startOnBike' | 'setStart' | 'autoPickup' | 'setDestination' | 'planLeg' | 'toggleStop' | 'markPartOpened' | 'openWalkToDock' | 'startRideTimer' | 'redockAlongWay' | 'undoRedock' | 'endRide' | 'finishPlan' | 'reset'
const empty = (): Omit<RideState, RideActions> => ({
  origin: null,
  startId: null,
  pickupPinned: false,
  walkToDockOpened: false,
  stopsForMaxRide: null,
  destination: null,
  routes: [],
  routeIndex: 0,
  route: null,
  status: 'idle',
  error: null,
  pendingRouteIndex: null,
  pastLegs: [],
  stopIds: [],
  openedParts: [],
  rideStartedAtMs: null,
  finished: false,
  continuingRide: false,
  bikeAt: null,
  redockedAtMs: null,
  loop: null,
})

type Persisted = Partial<Pick<RideState, 'loop' | 'origin' | 'pickupPinned' | 'walkToDockOpened' | 'stopsForMaxRide' | 'startId' | 'destination' | 'routes' | 'routeIndex' | 'stopIds' | 'openedParts' | 'rideStartedAtMs' | 'continuingRide' | 'redockedAtMs' | 'pastLegs' | 'bikeAt'>>

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Minimal shape check for a stored route (it came from our own API, but storage is untrusted). */
function isRouteLeg(v: unknown): v is RouteLeg {
  return (
    isObj(v) &&
    Array.isArray(v.geometry) &&
    v.geometry.length >= 2 &&
    v.geometry.every(isValidLngLat) &&
    Array.isArray(v.maneuvers) &&
    finite(v.distance) &&
    finite(v.duration) &&
    isValidLngLat(v.from) &&
    isValidLngLat(v.to)
  )
}

/** At most one route per BIKE_ROUTING option, each at its option's use_roads level (when the route records one). */
const matchesOptions = (routes: readonly RouteLeg[]) =>
  routes.length <= BIKE_ROUTING.options.length && routes.every((r, i) => r.useRoads === undefined || r.useRoads === BIKE_ROUTING.options[i]?.useRoads)

const HIGHLIGHT_KINDS = new Set<Highlight['kind']>(['trail', 'park', 'water', 'viewpoint'])

/** A stored loop's settings (storage is untrusted), or null. */
export function validateLoop(v: unknown): LoopSettings | null {
  if (!isObj(v) || !finite(v.minutes) || v.minutes < 5 || v.minutes > 240 || typeof v.roundTrip !== 'boolean' || !finite(v.seed)) return null
  const highlights = Array.isArray(v.highlights)
    ? v.highlights
        .filter((h): h is Highlight => isObj(h) && HIGHLIGHT_KINDS.has(h.kind as Highlight['kind']) && typeof h.name === 'string' && h.name.length <= 80)
        .slice(0, LOOP.maxHighlights)
        .map((h) => ({ kind: h.kind, name: h.name }))
    : []
  return { minutes: Math.round(v.minutes), roundTrip: v.roundTrip, seed: Math.floor(v.seed) >>> 0, highlights, fellBack: v.fellBack === true }
}

/** A saved finished-leg line longer than this is dropped (storage is untrusted; real ones are far shorter). */
const MAX_PAST_LEG_POINTS = 20_000

/** Restores a persisted plan, or nothing when it is missing or malformed. */
export function restoreRide(raw: unknown, nowMs: number): Partial<RideState> {
  if (!isObj(raw)) return {}
  const startId = typeof raw.startId === 'string' && ID_RE.test(raw.startId) ? raw.startId : null
  const destination = validatePlace(raw.destination)
  const loop = validateLoop(raw.loop)
  // A loop not routed yet has no destination: it is planned again from its settings.
  if (startId && loop && !destination) return { startId, origin: validatePlace(raw.origin), pickupPinned: raw.pickupPinned === true, loop }
  if (!startId || !destination) return {}
  const savedStart = finite(raw.rideStartedAtMs) && raw.rideStartedAtMs <= nowMs ? raw.rideStartedAtMs : null
  // A timer older than RIDE.maxRideAgeMs is a ride that ended long ago without being ended here: the plan stays,
  // its progress (timer, opened links, the walk to the dock, a kept bike) doesn't.
  const stale = savedStart !== null && nowMs - savedStart > RIDE.maxRideAgeMs
  const started = stale ? null : savedStart
  // Routes saved for other route options (an older version of the app) are dropped: the plan is routed again. So are
  // a stale ride's routes from where the rider was on a bike: without that ride, the plan starts at its dock.
  const fromRider = raw.continuingRide === true && isValidLngLat(raw.bikeAt)
  // A loop is one route (at LOOP.useRoads), not the route options.
  const fits = (r: RouteLeg[]) => (loop ? r.length === 1 : matchesOptions(r))
  const routes = Array.isArray(raw.routes) && raw.routes.every(isRouteLeg) && fits(raw.routes as RouteLeg[]) && !(stale && fromRider) ? (raw.routes as RouteLeg[]) : []
  const routeIndex = finite(raw.routeIndex) && raw.routeIndex >= 0 && raw.routeIndex < routes.length ? Math.floor(raw.routeIndex) : 0
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 50) : [])
  const parts = Array.isArray(raw.openedParts) && !stale ? raw.openedParts.filter((x): x is number => finite(x) && x >= 0 && x < 50) : []
  const origin = validatePlace(raw.origin)
  return {
    loop,
    origin,
    pickupPinned: raw.pickupPinned === true,
    walkToDockOpened: routes.length > 0 && !stale && raw.walkToDockOpened === true,
    stopsForMaxRide: finite(raw.stopsForMaxRide) ? raw.stopsForMaxRide : null,
    startId,
    destination,
    routes,
    routeIndex,
    route: routes[routeIndex] ?? null,
    status: routes.length ? 'ready' : 'idle',
    stopIds: routes.length ? ids(raw.stopIds) : [],
    openedParts: routes.length ? parts : [],
    // A ride carried over from the previous leg keeps its timer even before this leg is routed.
    rideStartedAtMs: routes.length || raw.continuingRide === true ? started : null,
    continuingRide: raw.continuingRide === true && started !== null,
    bikeAt: raw.continuingRide === true && started !== null && isValidLngLat(raw.bikeAt) ? [raw.bikeAt[0], raw.bikeAt[1]] : null,
    // Only as the timer's own start (the claim restarted it); anything else is stale.
    redockedAtMs: started !== null && raw.redockedAtMs === started ? started : null,
    pastLegs: Array.isArray(raw.pastLegs)
      ? raw.pastLegs
          .filter((l): l is LngLat[] => Array.isArray(l) && l.length >= 2 && l.length <= MAX_PAST_LEG_POINTS && l.every(isValidLngLat))
          .slice(-RIDE.maxTripStops)
      : [],
  }
}

export const useRideStore = create<RideState>()(
  persist(
    (set, get) => ({
      ...empty(),
      startLoop: ({ minutes, roundTrip }) =>
        set((s) => ({ loop: { minutes, roundTrip, seed: newSeed(), highlights: [], fellBack: false }, destination: null, ...planReset(), ...carried(s), finished: false })),
      shuffleLoop: () =>
        set((s) => (s.loop ? { loop: { ...s.loop, seed: (s.loop.seed + 1 + Math.floor(Math.random() * 1000)) >>> 0, highlights: [], fellBack: false }, destination: null, ...planReset(), ...carried(s), finished: false } : s)),
      // A loop keeps its settings when the start changes; its destination (where it ends) is planned again.
      setOrigin: (origin) =>
        set((s) => ({
          ...(origin?.stationId ? { origin, startId: origin.stationId, pickupPinned: true } : { origin, startId: null, pickupPinned: false }),
          ...planReset(),
          ...(s.loop ? { destination: null } : {}),
          finished: false,
        })),
      startOnBike: (at, dock, startedAtMs) =>
        dock.stationId
          ? set((s) => ({ origin: dock, startId: dock.stationId, pickupPinned: true, ...planReset(), ...(s.loop ? { destination: null } : {}), finished: false, bikeAt: at, continuingRide: true, rideStartedAtMs: startedAtMs }))
          : undefined,
      setStart: (startId) =>
        set((s) =>
          startId === null
            ? { origin: null, startId: null, pickupPinned: false, ...planReset(), ...(s.loop ? { destination: null } : {}), finished: false }
            : { startId, pickupPinned: true, origin: s.origin && !s.origin.stationId ? s.origin : null, ...planReset(), ...(s.loop ? { destination: null } : {}), finished: false },
        ),
      // Unchanged: the same state object, so nothing re-renders (the planner calls this on every count update).
      autoPickup: (id) => set((s) => (s.startId === id ? s : { startId: id, ...planReset(), ...(s.loop ? { destination: null } : {}), finished: false })),
      // On the bike from the previous leg, a new destination is still the same BCycle ride: its timer goes on.
      // A destination of the rider's own ends "Just ride".
      setDestination: (destination) => set((s) => ({ destination, loop: null, ...planReset(), ...carried(s), finished: false })),
      planLeg: ({ origin, startId, pickupPinned, destination }) => set({ origin, startId, pickupPinned, destination, loop: null, ...planReset(), finished: false }),
      // Keeps the ride's progress: mid-ride, a rider who switches to another dock (say the end dock filled up)
      // is still on the same BCycle ride, so its timer and background alerts carry on.
      toggleStop: (id, routeOrder) =>
        set((s) => {
          const chosen = new Set(s.stopIds)
          if (chosen.has(id)) chosen.delete(id)
          else chosen.add(id)
          return { stopIds: routeOrder.filter((x) => chosen.has(x)), finished: false }
        }),
      markPartOpened: (index, fromDock, startTimer = true) =>
        set((s) => ({
          redockedAtMs: null,
          openedParts: s.openedParts.includes(index) ? s.openedParts : [...s.openedParts, index].sort((a, b) => a - b),
          // Opening a part that starts at a dock = unlocking a bike there: a new BCycle ride (timer restarts).
          // Not when the rider still has to walk to the dock: they start the timer once they've unlocked.
          // The first part of a leg ridden on the bike kept from the previous leg: no new BCycle ride.
          // Nor a link opened right after "Docked along the way": that was this unlock (keep the claimed start).
          rideStartedAtMs:
            !startTimer ||
            (index === 0 && s.continuingRide && s.rideStartedAtMs !== null) ||
            (s.redockedAtMs !== null && s.rideStartedAtMs === s.redockedAtMs && Date.now() - s.redockedAtMs <= RIDE.redockLinkGraceSeconds * 1000)
              ? s.rideStartedAtMs
              : fromDock && !s.openedParts.includes(index)
                ? Date.now()
                : (s.rideStartedAtMs ?? Date.now()),
        })),
      openWalkToDock: () => set({ walkToDockOpened: true }),
      startRideTimer: () => set({ rideStartedAtMs: Date.now() }),
      redockAlongWay: (nowMs = Date.now()) => {
        const prev = get().rideStartedAtMs
        if (prev === null) return null
        set({ rideStartedAtMs: nowMs, redockedAtMs: nowMs })
        return prev
      },
      undoRedock: (previousStartMs) =>
        set((s) => (s.rideStartedAtMs !== null && s.redockedAtMs === s.rideStartedAtMs && previousStartMs <= s.rideStartedAtMs ? { rideStartedAtMs: previousStartMs, redockedAtMs: null } : s)),
      endRide: () => set({ openedParts: [], rideStartedAtMs: null, walkToDockOpened: false, continuingRide: false, redockedAtMs: null, bikeAt: null }),
      finishPlan: () => set({ finished: true }),
      reset: () => {
        abortRouting()
        set(empty())
      },
    }),
    {
      name: 'bcycle.ride',
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      // A finished plan is not saved: the next visit starts fresh.
      partialize: (s): Persisted => (s.finished ? {} : {
        loop: s.loop,
        origin: s.origin,
        pickupPinned: s.pickupPinned,
        walkToDockOpened: s.walkToDockOpened,
        stopsForMaxRide: s.stopsForMaxRide,
        startId: s.startId,
        destination: s.destination,
        routes: s.routes,
        routeIndex: s.routeIndex,
        stopIds: s.stopIds,
        openedParts: s.openedParts,
        rideStartedAtMs: s.rideStartedAtMs,
        continuingRide: s.continuingRide,
        redockedAtMs: s.redockedAtMs,
        pastLegs: s.pastLegs,
        bikeAt: s.bikeAt,
      }),
      merge: (persisted, current) => ({ ...current, ...restoreRide(persisted, Date.now()) }),
    },
  ),
)

const newSeed = () => Math.floor(Math.random() * 2 ** 31)

/** Options shared by the dock list and the optimized stops (rider's settings, fleet, route pace). */
function dockOpts(route: RouteLeg, snapshot: StationsSnapshot, destination: Place, partySize: number) {
  const { maxRideMinutes, preferEbikes } = useAppStore.getState().settings
  return {
    destination: destination.coord,
    destStationId: destination.stationId,
    partySize,
    electric: ridesElectric(snapshot.stations, preferEbikes),
    maxRideMinutes,
    secondsPerMeter: routePace(route),
  }
}

/**
 * Docks offered as stops along `route`: on the line, plus re-dock / near-destination exceptions, plus
 * `keepIds` (the stops already chosen) whatever their counts are now.
 */
export function docksAlong(route: RouteLeg, snapshot: StationsSnapshot, startId: string, destination: Place, partySize = 1, keepIds: readonly string[] = []): RouteDock[] {
  const opts = { excludeIds: new Set([startId]), ...dockOpts(route, snapshot, destination, partySize) }
  if (destination.stationId !== startId) return routeDocks(route.geometry, snapshot.stations, { keepIds, ...opts })
  // A loop back to the start dock ("Just ride"): the start dock ends it, at the end of the line. (Without this the
  // start would be skipped as the start, and the dock nearest it added as "near the destination" instead.)
  const docks = routeDocks(route.geometry, snapshot.stations, { keepIds: keepIds.filter((id) => id !== startId), ...opts })
  const start = snapshot.byId.get(startId)
  if (!start) return docks
  const back: RouteDock = { station: start, along: buildPolylineIndex(route.geometry).total, offset: haversine(route.geometry.at(-1)!, start.coord), reason: 'onRoute' }
  return [...docks.filter((d) => d.reason !== 'nearDestination' || keepIds.includes(d.station.id)), back]
}

/** The route's own riding pace (seconds per meter), so stop timing matches the route cards. */
export const routePace = (route: RouteLeg): number | undefined => (route.distance > 0 && route.duration > 0 ? route.duration / route.distance : undefined)

/** The optimized stops for `docks`: fewest re-docks within the rider's max ride time, ending near the destination. */
export function optimizedFor(docks: readonly RouteDock[], route: RouteLeg, snapshot: StationsSnapshot, destination: Place, partySize = 1): string[] {
  return optimizedStops(docks, dockOpts(route, snapshot, destination, partySize))
}

/** Shows route option `index` with its optimized stops preselected (the rider can add optional ones). */
export function chooseRoute(index: number, snapshot: StationsSnapshot, partySize: number): void {
  const { routes, startId, destination } = useRideStore.getState()
  const route = routes[index]
  if (!route || !startId || !destination) return
  useRideStore.setState({
    routeIndex: index,
    route,
    stopIds: optimizedFor(docksAlong(route, snapshot, startId, destination, partySize), route, snapshot, destination, partySize),
    openedParts: [],
    ...(useRideStore.getState().continuingRide ? {} : { rideStartedAtMs: null }),
    finished: false,
    stopsForMaxRide: useAppStore.getState().settings.maxRideMinutes,
  })
}

/**
 * The rider's max ride time changed since the stops were picked (e.g. in Settings): re-picks the optimized stops
 * for it. Never mid-ride — a part opened, or the timer started with "I've unlocked a bike" — since re-picking
 * clears the ride's progress.
 */
export function reoptimizeStops(snapshot: StationsSnapshot, partySize: number, maxRideMinutes: number): void {
  const r = useRideStore.getState()
  if (r.status === 'ready' && !rideUnderWay(r) && r.stopsForMaxRide !== maxRideMinutes) chooseRoute(r.routeIndex, snapshot, partySize)
}

/** A failed route request: its kind (the planner words it for the rider) and the technical message (for logs). */
export function rideError(err: unknown): { kind: RideErrorKind; message: string } {
  const e = toAppError(err)
  const kind: RideErrorKind =
    e.code === 'location_unroutable'
      ? 'unroutable'
      : e.code === 'upstream_unavailable' || e.code === 'rate_limited'
        ? 'busy'
        : e.code === 'no_route'
          ? 'noRoute'
          : e.code === 'network' || e.code === 'timeout'
            ? 'offline'
            : 'other'
  return { kind, message: e.message }
}

/**
 * Fetches the bike route options (BIKE_ROUTING.options) start dock → destination and preselects docks along the chosen one. On an
 * e-bike (an all-electric fleet, or "Prefer e-bikes" in a mixed one) the routes are timed at e-bike speed: the
 * planner's stop times and re-docks follow the chosen route's own pace, so they would otherwise be classic-bike
 * times.
 */
export async function loadRideRoute(systemId: string, snapshot: StationsSnapshot, units: 'imperial' | 'metric', partySize: number): Promise<void> {
  const { startId, destination, bikeAt } = useRideStore.getState()
  const start = startId ? snapshot.byId.get(startId) : undefined
  if (!start || !destination) return
  // The start dock itself (or a spot right by it) as the destination: nothing to ride, and nothing to ask the routers.
  // Already on a bike, the ride starts where the rider is (the start dock is only the dock nearest them, and may well
  // be where they're riding to): only the distance counts then.
  if ((!bikeAt && destination.stationId === start.id) || haversine(bikeAt ?? start.coord, destination.coord) < RIDE.minRideMeters) {
    useRideStore.setState((s) => ({ status: 'error', error: { kind: 'tooClose', message: 'Destination is where the ride starts' }, routes: [], route: null, stopIds: [], openedParts: [], rideStartedAtMs: null, ...carried(s) }))
    return
  }
  const electric = ridesElectric(snapshot.stations, useAppStore.getState().settings.preferEbikes)
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  useRideStore.setState((s) => ({ status: 'routing', error: null, routes: [], route: null, stopIds: [], openedParts: [], rideStartedAtMs: null, ...carried(s) }))
  try {
    const routes = await api.routes(
      {
        systemId,
        role: 'ride',
        mode: 'bike',
        // Already on a bike: from where the rider is, not the dock nearest them.
        from: bikeAt ?? start.coord,
        ...(bikeAt ? { fromIsUserPoint: true } : {}),
        to: destination.coord,
        units,
        language: APP.language,
        toIsUserPoint: destination.kind !== 'station',
        priority: 'interactive',
        ...(electric ? { bikeKind: 'electric' as const } : {}),
        ...(destination.stationId ? { stationId: destination.stationId } : {}),
      },
      ctrl.signal,
    )
    if (ctrl.signal.aborted) return
    // A share link's option, else the one the rider had (a new leg or destination keeps their choice).
    const { pendingRouteIndex: pending, routeIndex: had } = useRideStore.getState()
    useRideStore.setState({ routes, status: 'ready', pendingRouteIndex: null })
    chooseRoute(pending !== null && pending < routes.length ? pending : had < routes.length ? had : 0, snapshot, partySize)
  } catch (err) {
    if (ctrl.signal.aborted) return
    useRideStore.setState({ status: 'error', error: rideError(err) })
  }
}

/** Docks a "Just ride" may end at: installed, taking bikes back, with space for the party (the start dock aside). */
const loopEndDocks = (snapshot: StationsSnapshot, startId: string, partySize: number) =>
  snapshot.stations
    .filter((s) => s.id !== startId && s.status?.isInstalled && s.status.isReturning && s.status.docks >= partySize)
    .map((s) => ({ id: s.id, coord: s.coord }))

/**
 * "Just ride": plans the loop (src/routing/loop.ts: waypoints on the city's scenic trails, src/data/scenic.ts) for the
 * rider's settings and routes it (POST /api/loop). A route that came out more than LOOP.lengthTolerance off the
 * wanted length is planned once more at a corrected size. Then it becomes the plan's one route, with the dock it ends
 * at as the destination, and the docks along it preselected like any ride's.
 */
export async function loadLoopRoute(systemId: string, snapshot: StationsSnapshot, units: 'imperial' | 'metric', partySize: number): Promise<void> {
  const { startId, bikeAt, loop } = useRideStore.getState()
  const start = startId ? snapshot.byId.get(startId) : undefined
  if (!start || !loop) return
  const electric = ridesElectric(snapshot.stations, useAppStore.getState().settings.preferEbikes)
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  useRideStore.setState((s) => ({ status: 'routing', error: null, routes: [], route: null, stopIds: [], openedParts: [], rideStartedAtMs: null, ...carried(s) }))
  try {
    const points = await loadScenic(systemId)
    if (ctrl.signal.aborted) return
    const from = bikeAt ?? start.coord
    const target = loopTargetMeters(loop.minutes, SPEEDS.bikeKph[electric ? 'electric' : 'classic'])
    const endDocks = loopEndDocks(snapshot, start.id, partySize)
    let scale = 1
    let best: { route: RouteLeg; end: Station; fellBack: boolean } | null = null
    for (let attempt = 0; attempt < LOOP.maxAttempts; attempt++) {
      const plan = planLoop({ start: from, targetMeters: target, roundTrip: loop.roundTrip, seed: loop.seed, points, endDocks, scale })
      const end = (plan.end && snapshot.byId.get(plan.end.id)) || start
      const route = await api.loop(
        {
          systemId,
          role: 'ride',
          mode: 'bike',
          from,
          ...(bikeAt ? { fromIsUserPoint: true } : {}),
          to: end.coord,
          stationId: end.id,
          units,
          language: APP.language,
          priority: 'interactive',
          via: plan.via,
          ...(electric ? { bikeKind: 'electric' as const } : {}),
        },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) return
      const off = (r: RouteLeg) => Math.abs(r.distance / target - 1)
      if (!best || off(route) < off(best.route)) best = { route, end, fellBack: plan.fellBackToRoundTrip }
      if (off(route) <= LOOP.lengthTolerance || route.distance <= 0) break
      scale *= target / route.distance
    }
    if (!best) return
    const destination: Place = { kind: 'station', name: best.end.name, coord: best.end.coord, stationId: best.end.id }
    const highlights = routeHighlights(best.route.geometry, points, LOOP.highlightMeters, LOOP.maxHighlights)
    useRideStore.setState((s) => ({
      routes: [{ ...best.route, useRoads: LOOP.useRoads }],
      status: 'ready',
      pendingRouteIndex: null,
      destination,
      loop: s.loop ? { ...s.loop, highlights, fellBack: best.fellBack } : s.loop,
    }))
    chooseRoute(0, snapshot, partySize)
  } catch (err) {
    if (ctrl.signal.aborted) return
    useRideStore.setState({ status: 'error', error: rideError(err) })
  }
}
