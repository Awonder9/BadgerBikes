// Ride planning state: start dock → destination, route options, the docks the rider stops at, and the
// progress of a ride handed off to Google Maps (parts opened, ride timer).
//
// Persisted on the device, because switching to Google Maps and back can reload the page: coming back for
// "Part 2" must find the same plan, not an empty planner. It stays saved until the rider opens the last
// Google Maps link (the walk, or the last ride part) or arrives at the destination (finishPlan).
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { api } from '../api/client'
import { APP } from '../config'
import { toAppError } from '../lib/errors'
import { isValidLngLat } from '../lib/geo'
import { safeStorage } from '../lib/storage'
import { fleetComposition } from '../lib/stationState'
import { validatePlace } from '../store/validate'
import type { Place, RouteLeg, StationsSnapshot } from '../types'
import { useAppStore } from '../store/appStore'
import { optimizedStops, routeDocks, type RouteDock } from './stationsAlongRoute'

export type RideErrorKind = 'busy' | 'unroutable' | 'other'

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
  /** Route options in BIKE_ROUTING.options order (bike-friendly, balanced, fastest) and the one shown/used. */
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
  /** Start from a place or a dock (a dock is also the pickup); null clears the start. */
  setOrigin(place: Place | null): void
  /** Pick up at this dock (pins it); null clears the start entirely. */
  setStart(id: string | null): void
  /** The best pickup for the current origin (not pinned). */
  autoPickup(id: string): void
  setDestination(place: Place | null): void
  toggleStop(id: string, routeOrder: readonly string[]): void
  /** The rider opened Google Maps part `index`; `fromDock` = it starts where they unlock a bike. */
  markPartOpened(index: number, fromDock: boolean, startTimer?: boolean): void
  openWalkToDock(): void
  /** "I've unlocked a bike": starts the ride timer now. */
  startRideTimer(): void
  /** "I'm done": clears progress but keeps the plan. */
  endRide(): void
  /** Stop saving this plan on the device (last link opened, or arrived). */
  finishPlan(): void
  reset(): void
}

let inflight: AbortController | null = null

const planReset = (): Partial<RideState> => ({ routes: [], route: null, stopIds: [], status: 'idle', error: null, openedParts: [], rideStartedAtMs: null, walkToDockOpened: false })

type RideActions = 'setOrigin' | 'setStart' | 'autoPickup' | 'setDestination' | 'toggleStop' | 'markPartOpened' | 'openWalkToDock' | 'startRideTimer' | 'endRide' | 'finishPlan' | 'reset'
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
  stopIds: [],
  openedParts: [],
  rideStartedAtMs: null,
  finished: false,
})

type Persisted = Partial<Pick<RideState, 'origin' | 'pickupPinned' | 'walkToDockOpened' | 'stopsForMaxRide' | 'startId' | 'destination' | 'routes' | 'routeIndex' | 'stopIds' | 'openedParts' | 'rideStartedAtMs'>>

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

/** Restores a persisted plan, or nothing when it is missing or malformed. */
export function restoreRide(raw: unknown, nowMs: number): Partial<RideState> {
  if (!isObj(raw)) return {}
  const startId = typeof raw.startId === 'string' && ID_RE.test(raw.startId) ? raw.startId : null
  const destination = validatePlace(raw.destination)
  if (!startId || !destination) return {}
  const routes = Array.isArray(raw.routes) && raw.routes.length <= 3 && raw.routes.every(isRouteLeg) ? (raw.routes as RouteLeg[]) : []
  const routeIndex = finite(raw.routeIndex) && raw.routeIndex >= 0 && raw.routeIndex < routes.length ? Math.floor(raw.routeIndex) : 0
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 50) : [])
  const parts = Array.isArray(raw.openedParts) ? raw.openedParts.filter((x): x is number => finite(x) && x >= 0 && x < 50) : []
  const started = finite(raw.rideStartedAtMs) && raw.rideStartedAtMs <= nowMs ? raw.rideStartedAtMs : null
  const origin = validatePlace(raw.origin)
  return {
    origin,
    pickupPinned: raw.pickupPinned === true,
    walkToDockOpened: routes.length > 0 && raw.walkToDockOpened === true,
    stopsForMaxRide: finite(raw.stopsForMaxRide) ? raw.stopsForMaxRide : null,
    startId,
    destination,
    routes,
    routeIndex,
    route: routes[routeIndex] ?? null,
    status: routes.length ? 'ready' : 'idle',
    stopIds: routes.length ? ids(raw.stopIds) : [],
    openedParts: routes.length ? parts : [],
    rideStartedAtMs: routes.length ? started : null,
  }
}

export const useRideStore = create<RideState>()(
  persist(
    (set) => ({
      ...empty(),
      setOrigin: (origin) =>
        set(
          origin?.stationId
            ? { origin, startId: origin.stationId, pickupPinned: true, ...planReset(), finished: false }
            : { origin, startId: null, pickupPinned: false, ...planReset(), finished: false },
        ),
      setStart: (startId) =>
        set((s) =>
          startId === null
            ? { origin: null, startId: null, pickupPinned: false, ...planReset(), finished: false }
            : { startId, pickupPinned: true, origin: s.origin && !s.origin.stationId ? s.origin : null, ...planReset(), finished: false },
        ),
      autoPickup: (id) => set((s) => (s.startId === id ? {} : { startId: id, ...planReset(), finished: false })),
      setDestination: (destination) => set({ destination, ...planReset(), finished: false }),
      toggleStop: (id, routeOrder) =>
        set((s) => {
          const chosen = new Set(s.stopIds)
          if (chosen.has(id)) chosen.delete(id)
          else chosen.add(id)
          return { stopIds: routeOrder.filter((x) => chosen.has(x)), openedParts: [], rideStartedAtMs: null, finished: false }
        }),
      markPartOpened: (index, fromDock, startTimer = true) =>
        set((s) => ({
          openedParts: s.openedParts.includes(index) ? s.openedParts : [...s.openedParts, index].sort((a, b) => a - b),
          // Opening a part that starts at a dock = unlocking a bike there: a new BCycle ride (timer restarts).
          // Not when the rider still has to walk to the dock: they start the timer once they've unlocked.
          rideStartedAtMs: !startTimer ? s.rideStartedAtMs : fromDock && !s.openedParts.includes(index) ? Date.now() : (s.rideStartedAtMs ?? Date.now()),
        })),
      openWalkToDock: () => set({ walkToDockOpened: true }),
      startRideTimer: () => set({ rideStartedAtMs: Date.now() }),
      endRide: () => set({ openedParts: [], rideStartedAtMs: null, walkToDockOpened: false }),
      finishPlan: () => set({ finished: true }),
      reset: () => {
        inflight?.abort()
        set(empty())
      },
    }),
    {
      name: 'bcycle.ride',
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      // A finished plan is not saved: the next visit starts fresh.
      partialize: (s): Persisted => (s.finished ? {} : {
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
      }),
      merge: (persisted, current) => ({ ...current, ...restoreRide(persisted, Date.now()) }),
    },
  ),
)

/** Options shared by the dock list and the optimized stops (rider's settings, fleet, route pace). */
function dockOpts(route: RouteLeg, snapshot: StationsSnapshot, destination: Place, partySize: number) {
  return {
    destination: destination.coord,
    destStationId: destination.stationId,
    partySize,
    electric: fleetComposition(snapshot.stations) === 'electric',
    maxRideMinutes: useAppStore.getState().settings.maxRideMinutes,
    secondsPerMeter: routePace(route),
  }
}

/** Docks offered as stops along `route`: on the line, plus re-dock / near-destination exceptions. */
export function docksAlong(route: RouteLeg, snapshot: StationsSnapshot, startId: string, destination: Place, partySize = 1): RouteDock[] {
  return routeDocks(route.geometry, snapshot.stations, { excludeIds: new Set([startId]), ...dockOpts(route, snapshot, destination, partySize) })
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
    rideStartedAtMs: null,
    finished: false,
    stopsForMaxRide: useAppStore.getState().settings.maxRideMinutes,
  })
}

/** Rider-facing message for a failed route request. */
export function rideError(err: unknown): { kind: RideErrorKind; message: string } {
  const e = toAppError(err)
  if (e.code === 'location_unroutable') return { kind: 'unroutable', message: 'Move the destination closer to a street or path.' }
  if (e.code === 'upstream_unavailable' || e.code === 'rate_limited') {
    return {
      kind: 'busy',
      message:
        'The route server is busy right now. We use a free public routing service that handles about one request per second for everyone, so yours couldn’t get through. Please try again in a few seconds.',
    }
  }
  return { kind: 'other', message: e.message }
}

/** Fetches the 3 bike route options start dock → destination and preselects docks along the chosen one. */
export async function loadRideRoute(systemId: string, snapshot: StationsSnapshot, units: 'imperial' | 'metric', partySize: number): Promise<void> {
  const { startId, destination } = useRideStore.getState()
  const start = startId ? snapshot.byId.get(startId) : undefined
  if (!start || !destination) return
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  useRideStore.setState({ status: 'routing', error: null, routes: [], route: null, stopIds: [], openedParts: [], rideStartedAtMs: null })
  try {
    const routes = await api.routes(
      {
        systemId,
        role: 'ride',
        mode: 'bike',
        from: start.coord,
        to: destination.coord,
        units,
        language: APP.language,
        toIsUserPoint: destination.kind !== 'station',
        priority: 'interactive',
        ...(destination.stationId ? { stationId: destination.stationId } : {}),
      },
      ctrl.signal,
    )
    if (ctrl.signal.aborted) return
    const pending = useRideStore.getState().pendingRouteIndex
    useRideStore.setState({ routes, status: 'ready', pendingRouteIndex: null })
    chooseRoute(pending !== null && pending < routes.length ? pending : 0, snapshot, partySize)
  } catch (err) {
    if (ctrl.signal.aborted) return
    useRideStore.setState({ status: 'error', error: rideError(err) })
  }
}
