import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { PushRideRequest } from '../../api/contract'
import { createQueryClient } from '../../data/hooks'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { useBackgroundRideAlerts } from './backgroundAlerts'
import type { RidePlan } from './useRidePlan'

// The browser side of background ride alerts: when it registers the ride with the Worker, and that a ride
// that ends while its registration is still on the way is always cancelled last.
const KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device'

function fakePush() {
  const keyBytes = Uint8Array.from(atob(KEY.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0))
  const subscription = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: keyBytes.buffer },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }),
    unsubscribe: async () => true,
  }
  const registration = { pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } }
  Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => registration }, configurable: true })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' })
}

const plan = (o: { loaded?: boolean; end?: string } = {}) =>
  ({ start: o.loaded === false ? undefined : { id: 'st_a' }, end: o.end ? { station: { id: o.end } } : undefined, includedMinutes: 30 }) as unknown as RidePlan

function render(initial: RidePlan) {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook((p: RidePlan) => useBackgroundRideAlerts(p), { wrapper, initialProps: initial })
}

describe('background ride alerts (browser side)', () => {
  const calls: string[] = []
  let sent: PushRideRequest[] = []

  beforeEach(() => {
    calls.length = 0
    sent = []
    fakePush()
    useAppStore.setState({ ...initialAppState, systemId: 'bcycle_madison' })
    useAppStore.getState().setPassChoice('bcycle_madison', { planId: null, includedMinutes: 30 })
    useRideStore.getState().reset()
    useRideStore.setState({ openedParts: [0], rideStartedAtMs: 1_800_000_000_000 })
    vi.spyOn(api, 'meta').mockResolvedValue({ contactEmail: null, version: 'test', pushPublicKey: KEY })
    vi.spyOn(api, 'pushCancel').mockImplementation(async () => void calls.push('cancel'))
  })
  afterEach(() => {
    cleanup() // unmount: each test's hook is the only one watching the ride
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('registers the ride with its end dock, timer and pass once the plan is known', async () => {
    vi.spyOn(api, 'pushRide').mockImplementation(async (body) => void sent.push(body))
    const hook = render(plan({ loaded: false })) // stations still loading after a reload
    await act(async () => {})
    expect(sent).toEqual([])
    hook.rerender(plan({ end: 'st_c' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
      lang: 'en',
      systemId: 'bcycle_madison',
      endStationId: 'st_c',
      partySize: 1,
      rideStartedAtMs: 1_800_000_000_000,
      includedMinutes: 30,
    })
  })

  it('a ride that ends while its registration is on the way is cancelled after it, never before', async () => {
    let arrive = () => {}
    vi.spyOn(api, 'pushRide').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          calls.push('register')
          arrive = () => resolve()
        }),
    )
    render(plan({ end: 'st_c' }))
    await waitFor(() => expect(calls).toEqual(['register']))
    act(() => useRideStore.getState().endRide()) // "End ride" while the registration is still in flight
    await act(async () => {})
    expect(calls).toEqual(['register']) // the cancel waits for it
    await act(async () => arrive())
    await waitFor(() => expect(calls).toEqual(['register', 'cancel']))
  })

  it('a ride ended after a reload, before it was registered again (offline, stations loading), is still cancelled', async () => {
    const register = vi.spyOn(api, 'pushRide').mockImplementation(async () => void calls.push('register'))
    const cancelled = vi.mocked(api.pushCancel)
    render(plan({ loaded: false })) // the restored ride: the server still has it from before the reload
    await act(async () => {})
    act(() => useRideStore.getState().endRide())
    await waitFor(() => expect(calls).toEqual(['cancel']))
    expect(cancelled).toHaveBeenCalledWith(ENDPOINT)
    expect(register).not.toHaveBeenCalled()
  })

  it('opening the app without a ride cancels nothing', async () => {
    useRideStore.getState().reset()
    render(plan())
    await act(async () => {})
    expect(calls).toEqual([])
  })
})
