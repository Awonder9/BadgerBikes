import { beforeEach, describe, expect, it } from 'vitest'
import valhallaBike from '../test/fixtures/valhalla/route_bicycle.json'
import { normalizeValhallaRoute } from '../routing/valhalla'
import { restoreRide, useRideStore } from './rideStore'

const leg = normalizeValhallaRoute(valhallaBike, { role: 'ride', mode: 'bike', from: [-89.3842, 43.07467], to: [-89.4003, 43.07652], units: 'imperial', language: 'en-US' })
const dest = { kind: 'search' as const, name: 'Memorial Union', coord: [-89.4003, 43.07652] as [number, number] }
const now = 1_800_000_000_000

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

  it('changing the plan clears progress', () => {
    const s = useRideStore.getState()
    s.markPartOpened(0, true)
    s.toggleStop('x', ['x'])
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], rideStartedAtMs: null })
    s.markPartOpened(0, true)
    s.setDestination(dest)
    expect(useRideStore.getState().openedParts).toEqual([])
  })
})
