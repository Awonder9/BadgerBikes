// Multi-stop trips: several destinations in order (start → A → B → C). Each leg is its own BCycle ride,
// planned by the ordinary single-ride planner (rideStore.ts): leg 1 from the planner's start to the first stop,
// every later leg from the previous stop (walk to the best pickup dock near it, or start at it when the stop is
// a dock) to the next. The rider docks near each stop, so legs never share a bike, a ride timer or docks along
// the route — the docks of the leg on screen are chosen exactly as for a one-stop ride.
//
// Only the leg on screen lives in the ride store; this store keeps the list of stops, which leg is shown, and
// leg 1's start (to come back to it). Persisted like the ride plan, so it survives the trip to Google Maps.
//
// Finishing a leg (its last link opened, or arrived) asks the rider whether it is done and whether they docked
// (completeLeg): the finished stop and everything before it leave the trip, and the next leg is planned from
// there — after docking with the timer stopped, on the kept bike with the same BCycle ride's timer running on.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { RIDE } from '../config'
import { safeStorage } from '../lib/storage'
import { validatePlace } from '../store/validate'
import type { Place } from '../types'
import { useRideStore } from './rideStore'

/** Leg 1's start as the ride store had it: a place (with or without a chosen pickup dock) or a dock. */
export interface LegStart {
  origin: Place | null
  startId: string | null
  pickupPinned: boolean
}

export interface TripState {
  /** Every destination in order; a trip has at least 2 (fewer = an ordinary one-stop ride, this store unused). */
  stops: Place[]
  /** The leg shown in the planner: it ends at stops[leg]. */
  leg: number
  /** Leg 1's start, saved when the rider moves on to a later leg. */
  firstStart: LegStart | null
  /**
   * The last leg the rider finished (opened its last link or arrived), or -1. A finished leg with a next one waits
   * for completeLeg; its plan stays saved meanwhile (the ride timer may still be running).
   */
  finishedLeg: number
  /** Adds a stop at the end (the current destination becomes stop 1 when this starts a trip). */
  addStop(place: Place): void
  removeStop(index: number): void
  /** Swaps stop `index` with the one before it. */
  moveStopUp(index: number): void
  /** Shows leg `leg` in the planner (a fresh plan for it). */
  goToLeg(leg: number): void
  /**
   * The leg on screen is done: its stop and every earlier one leave the trip, and the next leg is planned from that
   * stop. `docked`: the BCycle ride ended there (timer stops; the next leg picks up a bike at or near the stop).
   * Otherwise the rider kept the bike: the next leg starts at `bikeDock` (the stop's dock, or the dock nearest it,
   * as the route's start) and the ride timer keeps running.
   */
  completeLeg(docked: boolean, bikeDock?: Place | null): void
  clear(): void
}

export const isTrip = (s: Pick<TripState, 'stops'>): boolean => s.stops.length >= 2

const samePlace = (a: Place | null | undefined, b: Place | null | undefined): boolean =>
  !!a && !!b && a.coord[0] === b.coord[0] && a.coord[1] === b.coord[1] && (a.stationId ?? null) === (b.stationId ?? null)

/** Where a later leg starts: at the previous stop (its dock, or the best pickup dock near it). */
export function legStartAt(stop: Place): LegStart {
  return stop.stationId ? { origin: stop, startId: stop.stationId, pickupPinned: true } : { origin: stop, startId: null, pickupPinned: false }
}

const rideStart = (): LegStart => {
  const r = useRideStore.getState()
  return { origin: r.origin, startId: r.startId, pickupPinned: r.pickupPinned }
}

// Declared before the store: restoring a saved trip runs while the store is created.
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/

const emptyTrip = { stops: [] as Place[], leg: 0, firstStart: null as LegStart | null, finishedLeg: -1 }

export const useTripStore = create<TripState>()(
  persist(
    (set, get) => {
      /**
       * Leg 1's start: the planner's own while it shows leg 1 (the rider may have changed it there), else the one
       * saved when the rider left leg 1.
       */
      const firstStartNow = (): LegStart | null => (get().leg === 0 ? rideStart() : get().firstStart)
      /** Puts leg `leg` of `stops` into the ride store as a fresh plan. */
      const show = (stops: Place[], leg: number) => {
        const destination = stops[leg]
        if (!destination) return
        const firstStart = firstStartNow()
        const start = leg === 0 ? (firstStart ?? rideStart()) : legStartAt(stops[leg - 1]!)
        set({ stops, leg, firstStart })
        useRideStore.getState().planLeg({ ...start, destination })
      }
      /** After an edit: re-plans the leg on screen only when its start or destination changed. */
      const edited = (stops: Place[], leg: number) => {
        const r = useRideStore.getState()
        if (stops.length < 2) {
          // Back to an ordinary one-stop ride, from leg 1's start to the stop that is left.
          const only = stops[0]
          const start = firstStartNow() ?? rideStart()
          const wasFirstLeg = get().leg === 0
          set(emptyTrip)
          if (only && !(wasFirstLeg && samePlace(only, r.destination))) useRideStore.getState().planLeg({ ...start, destination: only })
          return
        }
        const from = leg === 0 ? null : stops[leg - 1]
        // Same ends (the leg's number may have moved): the plan on screen, and any ride under way, stay as they are.
        const unchanged = samePlace(stops[leg], r.destination) && (leg === 0 ? get().leg === 0 : get().leg !== 0 && samePlace(from, r.origin))
        if (unchanged) set({ stops, leg })
        else show(stops, leg)
      }
      return {
        ...emptyTrip,
        addStop: (place) => {
          const { stops } = get()
          const dest = useRideStore.getState().destination
          const base = stops.length >= 2 ? stops : dest ? [dest] : []
          if (base.length === 0 || base.length >= RIDE.maxTripStops || samePlace(base.at(-1), place)) return
          set({ stops: [...base, place], leg: stops.length >= 2 ? get().leg : 0, finishedLeg: stops.length >= 2 ? get().finishedLeg : -1 })
        },
        removeStop: (index) => {
          const { stops, leg, finishedLeg } = get()
          if (index < 0 || index >= stops.length) return
          const next = stops.filter((_, i) => i !== index)
          if (index <= finishedLeg) set({ finishedLeg: finishedLeg - 1 })
          edited(next, Math.min(index < leg ? leg - 1 : leg, next.length - 1))
        },
        moveStopUp: (index) => {
          const { stops, leg } = get()
          if (index < 1 || index >= stops.length) return
          const next = [...stops]
          ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
          set({ finishedLeg: Math.min(get().finishedLeg, index - 2) })
          edited(next, leg)
        },
        goToLeg: (leg) => {
          const { stops, finishedLeg } = get()
          if (!isTrip(get()) || leg < 0 || leg >= stops.length) return
          // A leg planned again isn't finished any more.
          if (finishedLeg >= leg) set({ finishedLeg: leg - 1 })
          show(stops, leg)
        },
        completeLeg: (docked, bikeDock = null) => {
          const { stops, leg } = get()
          const done = stops[leg]
          const rest = stops.slice(leg + 1)
          const next = rest[0]
          if (!done || !next) return
          const r = useRideStore.getState()
          const timer = docked ? null : r.rideStartedAtMs
          const start: LegStart = !docked && bikeDock?.stationId ? { origin: bikeDock, startId: bikeDock.stationId, pickupPinned: true } : legStartAt(done)
          // The stops left: still a trip with 2 or more, else an ordinary one-stop ride to the last one.
          set(rest.length >= 2 ? { stops: rest, leg: 0, firstStart: null, finishedLeg: -1 } : emptyTrip)
          useRideStore.getState().planLeg({ ...start, destination: next })
          if (timer !== null) useRideStore.setState({ rideStartedAtMs: timer, continuingRide: true })
        },
        clear: () => set(emptyTrip),
      }
    },
    {
      name: 'bcycle.trip',
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      partialize: (s) => ({ stops: s.stops, leg: s.leg, firstStart: s.firstStart, finishedLeg: s.finishedLeg }),
      merge: (persisted, current) => ({ ...current, ...restoreTrip(persisted) }),
    },
  ),
)

/** Restores a saved trip, or none when it is missing or malformed (storage is untrusted). */
export function restoreTrip(raw: unknown): Partial<TripState> {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const stops = Array.isArray(r.stops) ? r.stops.slice(0, RIDE.maxTripStops).map(validatePlace) : []
  if (stops.length < 2 || stops.some((p) => !p)) return {}
  const int = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt)
  const fs = typeof r.firstStart === 'object' && r.firstStart !== null ? (r.firstStart as Record<string, unknown>) : null
  const startId = fs && typeof fs.startId === 'string' && ID_RE.test(fs.startId) ? fs.startId : null
  const origin = fs ? validatePlace(fs.origin) : null
  return {
    stops: stops as Place[],
    leg: int(r.leg, 0, stops.length - 1, 0),
    firstStart: origin || startId ? { origin, startId, pickupPinned: fs?.pickupPinned === true } : null,
    finishedLeg: int(r.finishedLeg, -1, stops.length - 1, -1),
  }
}

/**
 * Keeps the trip in step with the planner: a new destination typed for the leg on screen becomes that stop;
 * finishing the leg (last link opened, or arrived) is remembered; clearing the plan ends the trip.
 * A finished leg with a next one isn't a finished plan yet: it stays saved (with its ride timer) until the rider
 * answers whether the leg is done (completeLeg) — a reload or the trip to Google Maps must not lose either.
 */
useRideStore.subscribe((s, prev) => {
  const trip = useTripStore.getState()
  if (!isTrip(trip)) return
  if (!s.origin && !s.startId && !s.destination) return trip.clear()
  if (s.finished && !prev.finished) {
    if (trip.finishedLeg < trip.leg) useTripStore.setState({ finishedLeg: trip.leg })
    if (trip.leg < trip.stops.length - 1) useRideStore.setState({ finished: false })
  }
  if (s.destination && s.destination !== prev.destination && !samePlace(s.destination, trip.stops[trip.leg])) {
    const stops = [...trip.stops]
    stops[trip.leg] = s.destination
    useTripStore.setState({ stops })
  }
})

/**
 * At launch: the saved trip must match the saved plan. A finished leg waiting for "is it done?" is saved with its
 * plan; one finished before that existed wasn't (rideStore.finishPlan), so no plan with a finished leg shows the
 * next leg. Anything else that doesn't fit (the plan was cleared or replaced) ends the trip.
 */
export function reconcileTrip(): boolean {
  const trip = useTripStore.getState()
  if (!isTrip(trip)) return false
  const r = useRideStore.getState()
  if (r.destination && samePlace(r.destination, trip.stops[trip.leg])) return false
  if (!r.destination && trip.finishedLeg >= trip.leg && trip.leg < trip.stops.length - 1) {
    trip.goToLeg(trip.leg + 1)
    return true
  }
  trip.clear()
  return false
}

const resumed = reconcileTrip()
/** The app opened on the next leg of a trip (the last one was finished): the planner shows it right away. */
export const tripResumedAtLaunch = (): boolean => resumed
