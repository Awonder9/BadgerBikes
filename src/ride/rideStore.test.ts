import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetHttpState, setFetchImpl } from '../lib/http'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import { MADISON, makeSnapshot, makeStation } from '../test/factories'
import { normalizeValhallaRoute } from '../routing/valhalla'
import { AppError } from '../lib/errors'
import { BIKE_ROUTING, RIDE } from '../config'
import { initialAppState, useAppStore } from '../store/appStore'
import type { StationsSnapshot } from '../types'
import { chooseRoute, loadRideRoute, reoptimizeStops, restoreRide, rideError, routeChoiceLocked, useRideStore } from './rideStore'

const leg = normalizeValhallaRoute(valhallaBike, { role: 'ride', mode: 'bike', from: [-89.3842, 43.07467], to: [-89.4003, 43.07652], units: 'imperial', language: 'en-US' })
const dest = { kind: 'search' as const, name: 'Memorial Union', coord: [-89.4003, 43.07652] as [number, number] }
const now = 1_800_000_000_000

describe('route errors', () => {
  it('are told apart, so the planner words each in the rider’s language instead of showing the raw message', () => {
    const kinds = [
      new AppError('upstream_unavailable', 'x'),
      new AppError('rate_limited', 'x'),
      new AppError('location_unroutable', 'x'),
      new AppError('no_route', 'x'),
      new AppError('network', 'Network request failed: /api/routes'),
      new AppError('timeout', 'x'),
      new AppError('http', 'HTTP 502 for /api/routes'),
      new Error('boom'),
    ].map((e) => rideError(e).kind)
    expect(kinds).toEqual(['busy', 'busy', 'unroutable', 'noRoute', 'offline', 'offline', 'other', 'other'])
  })
})

describe('ride plan persistence', () => {
  const saved = { startId: 'bcycle_madison_1', destination: dest, routes: [leg, leg], routeIndex: 1, stopIds: ['a', 'b'], openedParts: [0], rideStartedAtMs: now - 60_000 }

  it('restores a recent plan, ready to use without re-routing', () => {
    const r = restoreRide(saved, now)
    expect(r).toMatchObject({ startId: 'bcycle_madison_1', routeIndex: 1, status: 'ready', stopIds: ['a', 'b'], openedParts: [0], rideStartedAtMs: now - 60_000 })
    expect(r.route?.distance).toBe(leg.distance)
  })

  it('drops the progress of a ride whose timer started too long ago (it ended without being ended here)', () => {
    const old = { ...saved, walkToDockOpened: true, rideStartedAtMs: now - RIDE.maxRideAgeMs - 1, redockedAtMs: now - RIDE.maxRideAgeMs - 1 }
    // The plan itself is kept, ready to ride again.
    expect(restoreRide(old, now)).toMatchObject({ startId: 'bcycle_madison_1', status: 'ready', stopIds: ['a', 'b'], openedParts: [], walkToDockOpened: false, rideStartedAtMs: null, continuingRide: false, redockedAtMs: null })
    // Within the limit, all of it comes back.
    expect(restoreRide({ ...old, rideStartedAtMs: now - RIDE.maxRideAgeMs, redockedAtMs: null }, now)).toMatchObject({ status: 'ready', openedParts: [0], walkToDockOpened: true, rideStartedAtMs: now - RIDE.maxRideAgeMs })
    // Planned from where the rider was on a bike: its routes start there, so without that ride it is routed again from the dock.
    const onBike = { ...old, continuingRide: true, bikeAt: [-89.39, 43.07] }
    expect(restoreRide(onBike, now)).toMatchObject({ startId: 'bcycle_madison_1', status: 'idle', routes: [], bikeAt: null, continuingRide: false, rideStartedAtMs: null })
    expect(restoreRide({ ...onBike, rideStartedAtMs: now - 60_000, redockedAtMs: null }, now)).toMatchObject({ status: 'ready', bikeAt: [-89.39, 43.07], continuingRide: true })
  })

  it('restores a trip\'s finished legs, dropping malformed ones', () => {
    const line = [[-89.4, 43.07], [-89.39, 43.07]]
    const r = restoreRide({ ...saved, pastLegs: [line, [[999, 0], [0, 0]], 'x', [[-89.4, 43.07]]] }, now)
    expect(r.pastLegs).toEqual([line])
    expect(restoreRide({ ...saved, pastLegs: 'nope' }, now).pastLegs).toEqual([])
  })

  it('routes again a plan saved for other route options (an older version of the app)', () => {
    // Three options before Direct / Bike-friendly.
    expect(restoreRide({ ...saved, routes: [leg, leg, leg] }, now)).toMatchObject({ status: 'idle', routes: [], stopIds: [] })
    // The same count, but at other use_roads levels.
    expect(restoreRide({ ...saved, routes: [{ ...leg, useRoads: 0 }, { ...leg, useRoads: 0.35 }] }, now)).toMatchObject({ status: 'idle', routes: [] })
    expect(restoreRide({ ...saved, routes: BIKE_ROUTING.options.map((o) => ({ ...leg, useRoads: o.useRoads })) }, now)).toMatchObject({ status: 'ready' })
  })

  it('keeps the timer of a ride carried over from a trip’s previous leg, even before this leg is routed', () => {
    const carried = { startId: 'bcycle_madison_1', destination: dest, routes: [], continuingRide: true, rideStartedAtMs: now - 60_000 }
    expect(restoreRide(carried, now)).toMatchObject({ status: 'idle', continuingRide: true, rideStartedAtMs: now - 60_000 })
    expect(restoreRide({ ...carried, rideStartedAtMs: null }, now)).toMatchObject({ continuingRide: false, rideStartedAtMs: null })
    expect(restoreRide({ ...carried, continuingRide: false }, now)).toMatchObject({ continuingRide: false, rideStartedAtMs: null })
  })

  it('drops malformed or partial plans', () => {
    expect(restoreRide({ ...saved, startId: '<script>' }, now)).toEqual({})
    expect(restoreRide('garbage', now)).toEqual({})
    // Bad routes: keep the ends (they re-route) but drop route-dependent state.
    const r = restoreRide({ ...saved, routes: [{ geometry: [[999, 0]] }] }, now)
    expect(r).toMatchObject({ status: 'idle', routes: [], stopIds: [], openedParts: [], rideStartedAtMs: null })
    expect(restoreRide({ ...saved, routeIndex: 9 }, now).routeIndex).toBe(0)
  })
})

describe('saving until the trip is done', () => {
  beforeEach(() => useRideStore.getState().reset())
  const persisted = () => useRideStore.persist.getOptions().partialize?.(useRideStore.getState()) as Record<string, unknown>

  it('keeps saving the plan until it is finished, then saves nothing; a new plan saves again', () => {
    const s = useRideStore.getState()
    s.setDestination(dest)
    expect(persisted()).toMatchObject({ destination: { name: 'Memorial Union' } })
    s.finishPlan()
    expect(persisted()).toEqual({})
    expect(useRideStore.getState().destination).toMatchObject({ name: 'Memorial Union' }) // still usable now
    s.setDestination({ ...dest, name: 'Capitol' })
    expect(persisted()).toMatchObject({ destination: { name: 'Capitol' } })
  })
})

describe('ride progress', () => {
  beforeEach(() => useRideStore.getState().reset())

  it('tracks opened parts and restarts the ride timer only when a part starts at a dock', () => {
    const s = useRideStore.getState()
    s.markPartOpened(0, true)
    const t0 = useRideStore.getState().rideStartedAtMs
    expect(t0).not.toBeNull()
    s.markPartOpened(1, false) // starts at a route point: same BCycle ride
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0, 1], rideStartedAtMs: t0 })
    s.markPartOpened(0, true) // re-opening part 1 does not restart the timer
    expect(useRideStore.getState().rideStartedAtMs).toBe(t0)
    s.endRide()
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], rideStartedAtMs: null })
  })

  it('changing the stops mid-ride keeps the ride timer; a new destination clears progress', () => {
    const s = useRideStore.getState()
    s.markPartOpened(0, true)
    const t0 = useRideStore.getState().rideStartedAtMs
    s.toggleStop('x', ['x']) // e.g. the end dock filled up and the rider picks another
    expect(useRideStore.getState()).toMatchObject({ stopIds: ['x'], openedParts: [0], rideStartedAtMs: t0 })
    s.setDestination(dest)
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], rideStartedAtMs: null })
  })

  it('locks the route options while a ride is under way (choosing one would clear its timer and alerts)', () => {
    const locked = () => routeChoiceLocked(useRideStore.getState())
    expect(locked()).toBe(false)
    useRideStore.getState().startRideTimer() // "I've unlocked a bike"
    expect(locked()).toBe(true)
    useRideStore.getState().endRide()
    useRideStore.getState().markPartOpened(0, false, false) // walking to the dock: a link is open
    expect(locked()).toBe(true)
    useRideStore.getState().endRide()
    expect(locked()).toBe(false)
    // Already on a bike, before a link is opened: switching options keeps the timer (chooseRoute), so it is free.
    useRideStore.getState().startOnBike([-89.39, 43.07], { kind: 'station', name: 'Dock', coord: [-89.39, 43.07], stationId: 'd' }, Date.now() - 60_000)
    expect(locked()).toBe(false)
    useRideStore.getState().markPartOpened(0, false)
    expect(locked()).toBe(true)
  })
})

describe('re-picking the stops after the max ride time changes (Settings)', () => {
  beforeEach(() => useRideStore.getState().reset())
  afterEach(() => useAppStore.setState({ ...initialAppState }))
  const snapshot = makeSnapshot([makeStation({ id: 'a', coord: MADISON.capitol }), makeStation({ id: 'b', coord: MADISON.memorialUnion })])

  it('happens before the ride, never once its timer runs (re-picking would clear the timer)', () => {
    useRideStore.setState({ startId: 'a', destination: dest, routes: [leg, leg, leg], routeIndex: 0, route: leg, status: 'ready', stopIds: ['b'], stopsForMaxRide: 25 })
    useAppStore.getState().updateSettings({ maxRideMinutes: 45 })
    // "I've unlocked a bike" after walking to the dock: the timer runs before any part is opened.
    useRideStore.setState({ rideStartedAtMs: now })
    reoptimizeStops(snapshot, 1, 45)
    expect(useRideStore.getState()).toMatchObject({ rideStartedAtMs: now, stopsForMaxRide: 25 })
    useRideStore.setState({ rideStartedAtMs: null, openedParts: [0] })
    reoptimizeStops(snapshot, 1, 45)
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0], stopsForMaxRide: 25 })
    useRideStore.setState({ openedParts: [] })
    reoptimizeStops(snapshot, 1, 45)
    expect(useRideStore.getState().stopsForMaxRide).toBe(45)
  })
})

describe('starting from a place', () => {
  beforeEach(() => useRideStore.getState().reset())
  const home = { kind: 'search' as const, name: 'Home', coord: [-89.41, 43.07] as [number, number] }

  it('a place needs a pickup dock (auto until the rider picks one); a dock is its own pickup', () => {
    const s = useRideStore.getState()
    s.setOrigin(home)
    expect(useRideStore.getState()).toMatchObject({ origin: { name: 'Home' }, startId: null, pickupPinned: false })
    s.autoPickup('auto')
    expect(useRideStore.getState()).toMatchObject({ startId: 'auto', pickupPinned: false })
    s.setStart('chosen') // the rider picks another dock: keeps the place, pins the dock
    expect(useRideStore.getState()).toMatchObject({ origin: { name: 'Home' }, startId: 'chosen', pickupPinned: true })
    s.setOrigin({ kind: 'station', name: 'Dock', coord: [-89.4, 43.07], stationId: 'dock' })
    expect(useRideStore.getState()).toMatchObject({ startId: 'dock', pickupPinned: true })
    s.setStart(null) // "Change" clears the whole start
    expect(useRideStore.getState()).toMatchObject({ origin: null, startId: null })
  })

  it('walking to the dock first: opening the first part does not start the timer; unlocking does', () => {
    const s = useRideStore.getState()
    s.setOrigin(home)
    s.openWalkToDock()
    s.markPartOpened(0, true, false)
    expect(useRideStore.getState()).toMatchObject({ walkToDockOpened: true, openedParts: [0], rideStartedAtMs: null })
    s.startRideTimer()
    const t0 = useRideStore.getState().rideStartedAtMs
    expect(t0).not.toBeNull()
    s.markPartOpened(1, true) // a re-dock later still restarts it
    expect(useRideStore.getState().rideStartedAtMs).toBeGreaterThanOrEqual(t0!)
  })
})

describe('routing the plan', () => {
  let restore: (() => void) | undefined
  beforeEach(() => useRideStore.getState().reset())
  afterEach(() => {
    restore?.()
    restore = undefined
    resetHttpState()
  })
  const snapshot = makeSnapshot([makeStation({ id: 'a', coord: MADISON.capitol }), makeStation({ id: 'b', coord: MADISON.libraryMall })])

  /** /api/routes answers only when `answer()` is called (and gives up if the request is aborted first). */
  function slowRoutes() {
    let answer = () => {}
    restore = setFetchImpl(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          answer = () => resolve(new Response(JSON.stringify({ routes: [leg, leg, leg] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }),
    )
    return () => answer()
  }

  it('shows the route options when they arrive', async () => {
    const answer = slowRoutes()
    useRideStore.getState().setStart('a')
    useRideStore.getState().setDestination(dest)
    const done = loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState().status).toBe('routing')
    answer()
    await done
    expect(useRideStore.getState()).toMatchObject({ status: 'ready', routeIndex: 0 })
    expect(useRideStore.getState().routes).toHaveLength(3)
  })

  it('a destination at the start dock (or right by it) is not sent to the routers: it says so instead', async () => {
    let requests = 0
    restore = setFetchImpl(async () => {
      requests++
      return new Response(JSON.stringify({ routes: [leg, leg] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    useRideStore.getState().setStart('a')
    useRideStore.getState().setDestination({ kind: 'station', name: 'a', coord: MADISON.capitol, stationId: 'a' })
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState()).toMatchObject({ status: 'error', error: { kind: 'tooClose' }, routes: [] })
    useRideStore.getState().setDestination({ kind: 'search', name: 'Across the street', coord: [MADISON.capitol[0] + 0.0003, MADISON.capitol[1]] })
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState().error?.kind).toBe('tooClose')
    expect(requests).toBe(0)
    useRideStore.getState().setDestination(dest)
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState().status).toBe('ready')
    expect(requests).toBe(1)
    // Already on a bike, riding to the dock nearest them (the plan's start dock): a real ride, routed.
    useRideStore.getState().startOnBike(MADISON.memorialUnion, { kind: 'station', name: 'a', coord: MADISON.capitol, stationId: 'a' }, Date.now() - 60_000)
    useRideStore.getState().setDestination({ kind: 'station', name: 'a', coord: MADISON.capitol, stationId: 'a' })
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState().status).toBe('ready')
    expect(requests).toBe(2)
  })

  it('already on a bike: routes from where the rider is, with the timer from when they unlocked; a new destination keeps it', async () => {
    const bodies: Array<{ from: unknown; fromIsUserPoint?: boolean }> = []
    restore = setFetchImpl(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { from: unknown })
      return new Response(JSON.stringify({ routes: [leg, leg] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const here: [number, number] = [-89.385, 43.074]
    const unlocked = Date.now() - 10 * 60_000
    useRideStore.getState().startOnBike(here, { kind: 'station', name: 'a', coord: MADISON.capitol, stationId: 'a' }, unlocked)
    useRideStore.getState().setDestination(dest)
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(bodies[0]).toMatchObject({ from: here, fromIsUserPoint: true })
    expect(useRideStore.getState()).toMatchObject({ startId: 'a', bikeAt: here, continuingRide: true, rideStartedAtMs: unlocked })
    // Its first link isn't an unlock: the timer keeps the unlock time.
    useRideStore.getState().markPartOpened(0, false)
    expect(useRideStore.getState().rideStartedAtMs).toBe(unlocked)
    // Changing the start ends it.
    useRideStore.getState().setStart(null)
    expect(useRideStore.getState()).toMatchObject({ bikeAt: null, continuingRide: false, rideStartedAtMs: null })
  })

  it('a new destination (or trip leg) keeps the route option the rider had chosen', async () => {
    restore = setFetchImpl(async () => new Response(JSON.stringify({ routes: [leg, leg] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    useRideStore.getState().setStart('a')
    useRideStore.getState().setDestination(dest)
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    chooseRoute(1, snapshot, 1)
    useRideStore.getState().setDestination({ ...dest, name: 'Elsewhere', coord: MADISON.libraryMall })
    await loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    expect(useRideStore.getState().routeIndex).toBe(1)
    // Clear starts over from the first option.
    useRideStore.getState().reset()
    expect(useRideStore.getState().routeIndex).toBe(0)
  })

  it('times the routes for the bike the rider will be on (the stop times and re-docks follow their pace)', async () => {
    const bikeKinds: unknown[] = []
    restore = setFetchImpl(async (_url, init) => {
      bikeKinds.push((JSON.parse(String(init?.body)) as { bikeKind?: unknown }).bikeKind ?? 'classic')
      return new Response(JSON.stringify({ routes: [leg, leg, leg] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const plan = async (snap: StationsSnapshot) => {
      useRideStore.getState().reset()
      useRideStore.getState().setStart('a')
      useRideStore.getState().setDestination(dest)
      await loadRideRoute('bcycle_madison', snap, 'imperial', 1)
    }
    const fleet = (o: { ebikes: number; classic: number }) =>
      makeSnapshot([makeStation({ id: 'a', coord: MADISON.capitol, ...o }), makeStation({ id: 'b', coord: MADISON.libraryMall, ...o })])
    try {
      await plan(snapshot) // all e-bikes, as in Madison
      await plan(fleet({ ebikes: 0, classic: 5 }))
      await plan(fleet({ ebikes: 2, classic: 3 }))
      useAppStore.getState().updateSettings({ preferEbikes: true })
      await plan(fleet({ ebikes: 2, classic: 3 }))
    } finally {
      useAppStore.setState({ ...initialAppState })
    }
    expect(bikeKinds).toEqual(['electric', 'classic', 'classic', 'electric'])
  })

  it('an answer for the previous start or destination never comes back as the plan', async () => {
    const answer = slowRoutes()
    const s = useRideStore.getState()
    s.setStart('a')
    s.setDestination(dest)
    const done = loadRideRoute('bcycle_madison', snapshot, 'imperial', 1)
    s.setStart(null) // "Change" while the request is out: the plan has no start now
    answer()
    await done
    expect(useRideStore.getState()).toMatchObject({ status: 'idle', startId: null, routes: [], route: null })
  })
})


describe('docked along the way', () => {
  const T0 = Date.now() - 20 * 60_000 // twenty minutes into the ride
  beforeEach(() => {
    useRideStore.getState().reset()
    useRideStore.setState({ startId: 'bcycle_madison_1', destination: dest, routes: [leg], route: leg, status: 'ready', stopIds: ['a', 'b'], openedParts: [0], rideStartedAtMs: T0 })
  })

  it('restarts only the timer: the plan, its opened links and a kept bike stay', () => {
    useRideStore.setState({ continuingRide: true })
    const t1 = Date.now()
    expect(useRideStore.getState().redockAlongWay(t1)).toBe(T0)
    expect(useRideStore.getState()).toMatchObject({ rideStartedAtMs: t1, redockedAtMs: t1, openedParts: [0], stopIds: ['a', 'b'], status: 'ready', continuingRide: true, destination: dest })
  })

  it('needs a running timer, and can be undone', () => {
    useRideStore.setState({ rideStartedAtMs: null })
    expect(useRideStore.getState().redockAlongWay()).toBeNull()
    expect(useRideStore.getState().rideStartedAtMs).toBeNull()
    useRideStore.setState({ rideStartedAtMs: T0 })
    const prev = useRideStore.getState().redockAlongWay()!
    useRideStore.getState().undoRedock(prev)
    expect(useRideStore.getState()).toMatchObject({ rideStartedAtMs: T0, redockedAtMs: null })
  })

  it('a link from a dock opened right after is the same unlock; later it is a new ride', () => {
    const t1 = Date.now() - 60_000
    useRideStore.getState().redockAlongWay(t1)
    useRideStore.getState().markPartOpened(1, true)
    expect(useRideStore.getState()).toMatchObject({ rideStartedAtMs: t1, redockedAtMs: null })
    const late = Date.now() - 10 * 60_000
    useRideStore.getState().redockAlongWay(late)
    useRideStore.getState().markPartOpened(2, true)
    expect(useRideStore.getState().rideStartedAtMs).toBeGreaterThan(late + 9 * 60_000)
  })

  it('is saved with the plan, and ending the ride clears it', () => {
    const t1 = Date.now() - 1000
    expect(restoreRide({ startId: 'x', destination: dest, routes: [leg], openedParts: [0], rideStartedAtMs: t1, redockedAtMs: t1 }, Date.now())).toMatchObject({ rideStartedAtMs: t1, redockedAtMs: t1 })
    expect(restoreRide({ startId: 'x', destination: dest, routes: [leg], openedParts: [0], rideStartedAtMs: t1, redockedAtMs: t1 - 5 }, Date.now())).toMatchObject({ redockedAtMs: null })
    useRideStore.getState().redockAlongWay()
    useRideStore.getState().endRide()
    expect(useRideStore.getState()).toMatchObject({ rideStartedAtMs: null, redockedAtMs: null })
  })
})
