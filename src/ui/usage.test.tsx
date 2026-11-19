import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { UsageRequest } from '../api/contract'
import { USAGE } from '../config'
import { useRideStore } from '../ride/rideStore'
import { initialAppState, useAppStore } from '../store/appStore'
import { resetUsageCounting, useUsageCounts } from './usage'

// The browser side of the usage counts: what a device sends, and that it sends nothing that could tell it apart.
const T0 = Date.UTC(2026, 10, 19, 18, 0, 30) // 12:00:30 in Chicago, 30 s into a check-in window
const DAY = 24 * 60 * 60_000

describe('usage counts (browser side)', () => {
  let sent: UsageRequest[] = []

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    sent = []
    localStorage.clear()
    resetUsageCounting()
    useAppStore.setState({ ...initialAppState, systemId: 'bcycle_madison' })
    useRideStore.getState().reset()
    vi.spyOn(api, 'usage').mockImplementation(async (r) => void sent.push(r))
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const flush = () => act(async () => {})

  it('a new device: an open with "new", check-ins once per window while visible, and the next day its gap', async () => {
    renderHook(() => useUsageCounts())
    await flush()
    expect(sent).toEqual([{ kind: 'open', first: { gap: null, systemId: 'bcycle_madison', platform: 'desktop', installed: false, lang: 'en' } }])
    // The next window: one check-in, no longer the day's first.
    await act(async () => vi.advanceTimersByTime(USAGE.beatMs))
    expect(sent.slice(1)).toEqual([{ kind: 'beat', first: null }])
    // Stored on the device: only its last active day and window.
    expect(Object.keys(JSON.parse(localStorage.getItem('bcycle.usage')!))).toEqual(['day', 'window'])

    // Two days later, a new page load: the day's first, two days after the previous one.
    cleanup()
    resetUsageCounting()
    vi.setSystemTime(T0 + 2 * DAY)
    renderHook(() => useUsageCounts())
    await flush()
    expect(sent.at(-1)).toEqual({ kind: 'open', first: { gap: 2, systemId: 'bcycle_madison', platform: 'desktop', installed: false, lang: 'en' } })
  })

  it('another open the same day (a reload, another tab) is not the first again; a ride start is counted once', async () => {
    renderHook(() => useUsageCounts())
    await flush()
    cleanup()
    resetUsageCounting()
    renderHook(() => useUsageCounts())
    await flush()
    expect(sent.map((r) => (r.kind === 'event' ? r.name : r.first?.gap))).toEqual([null, undefined])
    act(() => useRideStore.getState().markPartOpened(0, true))
    act(() => useRideStore.getState().markPartOpened(1, false))
    await flush()
    expect(sent.filter((r) => r.kind === 'event')).toEqual([{ kind: 'event', name: 'ride_start' }])
  })

  it('waits for the city on a first visit before the open', async () => {
    useAppStore.setState({ systemId: null })
    renderHook(() => useUsageCounts())
    await flush()
    expect(sent).toEqual([])
    act(() => void useAppStore.getState().setSystem('bcycle_boulder'))
    await flush()
    expect(sent).toMatchObject([{ kind: 'open', first: { gap: null, systemId: 'bcycle_boulder' } }])
  })

  it('sends nothing with Global Privacy Control or Do Not Track on', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: navigator.userAgent, globalPrivacyControl: true })
    renderHook(() => useUsageCounts())
    await flush()
    cleanup()
    vi.stubGlobal('navigator', { ...navigator, userAgent: navigator.userAgent, doNotTrack: '1' })
    renderHook(() => useUsageCounts())
    await flush()
    expect(sent).toEqual([])
  })
})
