import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetHttpState, setFetchImpl } from '../lib/http'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import { MADISON, makeSnapshot, makeStation } from '../test/factories'
import { normalizeValhallaRoute } from '../routing/valhalla'
import { AppError } from '../lib/errors'
import { initialAppState, useAppStore } from '../store/appStore'
import type { StationsSnapshot } from '../types'
import { loadRideRoute, reoptimizeStops, restoreRide, rideError, useRideStore } from './rideStore'

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
  const saved = { startId: 'bcycle_madison_1', destination: dest, routes: [leg, leg, leg], routeIndex: 2, stopIds: ['a', 'b'], openedParts: [0], rideStartedAtMs: now - 60_000 }

  it('restores a recent plan, ready to use without re-routing', () => {
    const r = restoreRide(saved, now)
    expect(r).toMatchObject({ startId: 'bcycle_madison_1', routeIndex: 2, status: 'ready', stopIds: ['a', 'b'], openedParts: [0], rideStartedAtMs: now - 60_000 })
    expect(r.route?.distance).toBe(leg.distance)
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

