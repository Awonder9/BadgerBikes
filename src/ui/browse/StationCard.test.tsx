import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient, qk } from '../../data/hooks'
import { setFetchImpl } from '../../lib/http'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { MADISON, makeStation } from '../../test/factories'
import type { SystemDetails } from '../../types'

const device = vi.hoisted(() => ({ platform: 'android' as 'ios' | 'android' | 'desktop', native: false }))
vi.mock('../platform', () => ({ platform: () => device.platform, isNativeApp: () => device.native, shareOrigin: () => 'https://badgerbikes.app' }))

const { AppHandoff, StationCard } = await import('./StationCard')

const STORE = 'https://play.google.com/store/apps/details?id=com.bcycle.bcycle'
const details = { rentalApps: { ios: null, android: { discoveryUri: 'bcycle://', storeUri: STORE } } } as unknown as SystemDetails

afterEach(() => {
  cleanup()
  useAppStore.setState({ ...initialAppState })
  useRideStore.getState().reset()
})

describe('the BCycle button on Android', () => {
  it('launches BCycle from Chrome; in our Android app, whose web view can’t open intent:// links, opens its Play Store page', () => {
    device.native = false
    render(<AppHandoff details={details} />)
    expect(screen.getByRole('link', { name: 'BCycle' }).getAttribute('href')).toMatch(/^intent:\/\/#Intent;.*package=com\.bcycle\.bcycle;/)
    cleanup()
    device.native = true
    render(<AppHandoff details={details} />)
    const link = screen.getByRole('link', { name: 'BCycle' })
    expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual([STORE, '_blank'])
  })
})

describe('“Ride to here” on a dock’s card', () => {
  it('plans a ride there; mid-ride it gives bike directions from here instead, keeping the ride and its timer', () => {
    const restore = setFetchImpl(() => Promise.reject(new Error('no network in tests')))
    try {
      const client = createQueryClient()
      const now = Date.now()
      client.setQueryData(qk.stations('bcycle_madison'), { systemId: 'bcycle_madison', lastUpdatedMs: now, fetchedAtMs: now, stations: [makeStation({ id: 'st_a', name: 'Alpha Dock', coord: MADISON.libraryMall })] })
      client.setQueryData(qk.system('bcycle_madison'), details)
      useAppStore.setState({ systemId: 'bcycle_madison', selectedStationId: 'st_a', panel: 'station' })
      const card = () =>
        render(
          <QueryClientProvider client={client}>
            <StationCard />
          </QueryClientProvider>,
        )
      card()
      expect(screen.getByRole('button', { name: 'Ride to here' })).toBeTruthy()
      cleanup()

      // "Nearest open dock" on the ride card (the end dock filled up) opens this card mid-ride.
      useRideStore.setState({ openedParts: [0], rideStartedAtMs: now - 5 * 60_000 })
      card()
      expect(screen.queryByRole('button', { name: 'Ride to here' })).toBeNull()
      const link = screen.getByRole('link', { name: 'Bike directions to Alpha Dock in Google Maps' })
      expect(link.getAttribute('href')).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=43\.07487\d*%2C-89\.39955\d*&travelmode=bicycling$/)
      expect(useRideStore.getState()).toMatchObject({ openedParts: [0], rideStartedAtMs: now - 5 * 60_000 })
    } finally {
      restore()
    }
  })
})
