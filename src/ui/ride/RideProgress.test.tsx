import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createQueryClient } from '../../data/hooks'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { RideBanner } from './RideProgress'

describe('the ride banner over the map', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialAppState }) // no city: no station requests, so no end dock is known
    useRideStore.getState().reset()
  })
  afterEach(() => {
    cleanup()
  })

  it('is not an alert while the end dock is unknown (stations still loading after a reload)', () => {
    useRideStore.setState({ openedParts: [0], rideStartedAtMs: Date.now() - 60_000 })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RideBanner />
      </QueryClientProvider>,
    )
    const banner = screen.getByRole('button', { name: /Ride in progress/ })
    expect(banner.className).toContain('bg-brand-700')
    expect(banner.className).not.toContain('bg-red-700')
  })
})
