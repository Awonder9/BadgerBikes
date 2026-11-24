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
})
