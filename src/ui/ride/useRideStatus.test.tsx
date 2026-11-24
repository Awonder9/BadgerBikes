import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RIDE } from '../../config'
import { createQueryClient } from '../../data/hooks'
import { useLocationStore } from '../../location/locationStore'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { MADISON } from '../../test/factories'
import type { RidePlan } from './useRidePlan'
import { useArrivalCheck, useRideAlerts } from './useRideStatus'

// The in-app ride alerts: each fires once per condition, and a new BCycle ride (a re-dock restarts the
// timer) gets its own "almost up" / "over" alerts.
const plan = { start: { id: 'st_a' }, end: undefined, includedMinutes: 30 } as unknown as RidePlan

function render() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useRideAlerts(plan), { wrapper })
}

describe('in-app ride alerts', () => {
  const vibrate = vi.fn<(pattern: VibratePattern) => boolean>(() => true)

  beforeEach(() => {
    vibrate.mockClear()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    useAppStore.setState({ ...initialAppState }) // no city: no station requests
    useRideStore.getState().reset()
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('warns once per ride timer, and again after a re-dock starts a new one', async () => {
    const now = Date.now()
    useRideStore.setState({ openedParts: [0], rideStartedAtMs: now - 26 * 60_000 }) // 4 min left of 30
    const hook = render()
    await act(async () => {})
    expect(vibrate).toHaveBeenCalledTimes(1)
    hook.rerender()
    await act(async () => {})
    expect(vibrate).toHaveBeenCalledTimes(1) // same timer: no repeat

    act(() => useRideStore.setState({ rideStartedAtMs: now - 27 * 60_000 })) // a new BCycle ride's timer
    await act(async () => {})
    expect(vibrate).toHaveBeenCalledTimes(2)
  })
})

describe('a loop back to its start dock', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn<(pattern: VibratePattern) => boolean>(() => true), configurable: true })
    useAppStore.setState({ ...initialAppState })
    useRideStore.getState().reset()
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('isn’t "end dock full" just after starting from that (full) dock: the feed hasn’t shown the bike taken yet', async () => {
    const full = { start: { id: 'st_a' }, end: { station: { id: 'st_a', name: 'Dock A', status: { bikes: 9, docks: 0, ebikes: 0, classic: 9, isInstalled: true, isRenting: true, isReturning: true } } }, includedMinutes: null } as unknown as RidePlan
    const loop = { minutes: 30, roundTrip: true, seed: 1, highlights: [], fellBack: false }
    useRideStore.setState({ startId: 'st_a', destination: { kind: 'station', name: 'Dock A', coord: [-89.4, 43.07], stationId: 'st_a' }, loop, openedParts: [0], rideStartedAtMs: Date.now() - 60_000 })
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const hook = renderHook(() => useRideAlerts(full), { wrapper })
    await act(async () => {})
    expect(navigator.vibrate).not.toHaveBeenCalled()
    // Later in the ride the dock really is full: that is said.
    act(() => useRideStore.setState({ rideStartedAtMs: Date.now() - RIDE.loopEndWatchDelayMs - 1000 }))
    hook.rerender()
    await act(async () => {})
    expect(navigator.vibrate).toHaveBeenCalledTimes(1)
  })
})

describe('arriving at the destination', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialAppState })
    useRideStore.getState().reset()
    useLocationStore.setState({ fix: null, geoError: null })
  })
  afterEach(() => cleanup())

  it('ends the ride only on an accurate position: a coarse fix landing near it mid-ride does not', async () => {
    const startedAt = Date.now() - 10 * 60_000
    useRideStore.setState({ destination: { kind: 'search', name: 'Memorial Union', coord: MADISON.memorialUnion }, openedParts: [0], rideStartedAtMs: startedAt })
    renderHook(() => useArrivalCheck())
    const fixAt = (accuracy: number) => ({ coord: MADISON.memorialUnion, accuracy, heading: null, speed: null, timestampMs: Date.now() })
    act(() => useLocationStore.getState().setFix(fixAt(RIDE.arrivedMaxAccuracyMeters + 300))) // a cell-tower fix
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0], rideStartedAtMs: startedAt, finished: false })
    act(() => useLocationStore.getState().setFix(fixAt(15)))
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], rideStartedAtMs: null, finished: true })
  })

  // A destination 90 m from the start dock (within the arrival circle): the rider opens the first link standing at the dock.
  const startDock: [number, number] = [-89.4, 43.07]
  const nearby: [number, number] = [-89.4, 43.07081]
  const route = (durationS: number) => ({ from: startDock, to: nearby, geometry: [startDock, nearby], maneuvers: [], distance: 400, duration: durationS }) as never
  const fix = (coord: [number, number], timestampMs = Date.now()) => ({ coord, accuracy: 10, heading: null, speed: null, timestampMs })

  it('a ride starting right by its destination is arrived at only after leaving, not when its first link opens', async () => {
    const startedAt = Date.now()
    useRideStore.setState({ destination: { kind: 'search', name: 'Café', coord: nearby }, route: route(600), openedParts: [0], rideStartedAtMs: startedAt })
    renderHook(() => useArrivalCheck())
    act(() => useLocationStore.getState().setFix(fix(startDock)))
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0], finished: false })
    act(() => useLocationStore.getState().setFix(fix([-89.4, 43.0755]))) // 500 m away
    await act(async () => {})
    act(() => useLocationStore.getState().setFix(fix(nearby)))
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], finished: true })
  })

  it('after a reload that never saw the rider leave, half the planned ride is enough (a loop back to its dock)', async () => {
    const startedAt = Date.now() - 20 * 60_000
    useRideStore.setState({
      startId: 'st_a',
      loop: { minutes: 30, roundTrip: true, seed: 1, highlights: [], fellBack: false },
      destination: { kind: 'station', name: 'Dock A', coord: startDock, stationId: 'st_a' },
      route: { ...(route(30 * 60) as object), to: startDock } as never,
      openedParts: [0],
      rideStartedAtMs: startedAt,
    })
    renderHook(() => useArrivalCheck())
    // Back at the dock 20 minutes into a 30-minute loop, the page reloaded meanwhile: arrived.
    act(() => useLocationStore.getState().setFix(fix(startDock)))
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [], finished: true })
  })

  it('a timer carried over from an earlier leg is no sign of having left', async () => {
    useRideStore.setState({ destination: { kind: 'search', name: 'Café', coord: nearby }, route: route(600), openedParts: [0], rideStartedAtMs: Date.now() - 60 * 60_000, continuingRide: true })
    renderHook(() => useArrivalCheck())
    act(() => useLocationStore.getState().setFix(fix(startDock)))
    await act(async () => {})
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0], finished: false })
  })
})
