import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRideStore } from '../../ride/rideStore'
import type { RidePlan } from './useRidePlan'

const scheduleTimerAlerts = vi.hoisted(() => vi.fn<(alerts: ReadonlyArray<{ kind: string }>, channel: string, exact: boolean | null) => void>())
vi.mock('../../native/notifications', () => ({ scheduleTimerAlerts }))
vi.mock('../platform', () => ({ isNativeApp: () => true }))
vi.mock('../notifications', () => ({ useNotificationAccess: () => 'granted', useExactAlarmAccess: () => true }))

const { useNativeRideAlerts } = await import('./nativeRideAlerts')
const plan = { includedMinutes: 30 } as RidePlan

beforeEach(() => {
  useRideStore.getState().reset()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ride alerts scheduled on the phone (iOS/Android apps)', () => {
  it('are left alone when the app starts without the ride (its plan stopped being saved once its last link opened)', () => {
    renderHook(() => useNativeRideAlerts(plan))
    expect(scheduleTimerAlerts).not.toHaveBeenCalled()
  })

  it('are scheduled while a ride’s timer runs and cancelled when the ride ends here', () => {
    useRideStore.setState({ openedParts: [0], rideStartedAtMs: Date.now() })
    renderHook(() => useNativeRideAlerts(plan))
    expect(scheduleTimerAlerts.mock.lastCall?.[0].map((a) => a.kind)).toEqual(['warn', 'over'])
    act(() => useRideStore.getState().endRide())
    expect(scheduleTimerAlerts.mock.lastCall?.[0]).toEqual([])
    expect(scheduleTimerAlerts).toHaveBeenCalledTimes(2)
  })
})
