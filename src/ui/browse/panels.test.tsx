import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createQueryClient, qk } from '../../data/hooks'
import { setFetchImpl } from '../../lib/http'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { MADISON } from '../../test/factories'
import { PinCard } from './panels'

afterEach(() => {
  cleanup()
  useAppStore.setState({ ...initialAppState })
  useRideStore.getState().reset()
})

describe('a dropped pin’s card', () => {
  it('plans a ride to the pin; mid-ride “Ride here” gives bike directions from here instead, keeping the ride', () => {
    const restore = setFetchImpl(() => Promise.reject(new Error('no network in tests')))
    try {
      const pin = MADISON.memorialUnion
      const client = createQueryClient()
      client.setQueryData(qk.reverse(pin[0].toFixed(5), pin[1].toFixed(5)), { kind: 'mapPick', name: 'Memorial Union', coord: pin })
      useAppStore.setState({ systemId: 'bcycle_madison', pin, panel: 'pin' })
      const card = () =>
        render(
          <QueryClientProvider client={client}>
            <PinCard />
          </QueryClientProvider>,
        )
      card()
      expect(screen.getByRole('button', { name: 'Ride here' })).toBeTruthy()
      cleanup()

      // A saved place's marker tapped on the map mid-ride opens this card.
      const startedAt = Date.now() - 5 * 60_000
      useRideStore.setState({ openedParts: [0], rideStartedAtMs: startedAt })
      card()
      expect(screen.queryByRole('button', { name: 'Ride here' })).toBeNull()
      const link = screen.getByRole('link', { name: 'Bike directions to Memorial Union in Google Maps' })
      expect(new URL(link.getAttribute('href')!).searchParams.get('travelmode')).toBe('bicycling')
      expect(useRideStore.getState()).toMatchObject({ openedParts: [0], rideStartedAtMs: startedAt })
    } finally {
      restore()
    }
  })
})
