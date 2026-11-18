import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoFix, LngLat } from '../types'
import { useLocationStore, waitForFix } from './locationStore'

const fixAt = (coord: LngLat, timestampMs = Date.now()): GeoFix => ({ coord, accuracy: 10, heading: null, speed: null, timestampMs })
const HERE: LngLat = [-89.4, 43.07]
const THERE: LngLat = [-89.41, 43.08]

describe('rider location', () => {
  beforeEach(() => useLocationStore.setState({ fix: null, geoError: null, requested: false, attempt: 0 }))
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asking again after an error starts a new watch; asking while it runs changes nothing', () => {
    useLocationStore.getState().requestLocation()
    expect(useLocationStore.getState()).toMatchObject({ requested: true, attempt: 1 })
    useLocationStore.getState().requestLocation()
    expect(useLocationStore.getState().attempt).toBe(1)
    useLocationStore.getState().setGeoError('geo_denied')
    useLocationStore.getState().requestLocation() // e.g. after allowing location in the browser settings
    expect(useLocationStore.getState()).toMatchObject({ attempt: 2, geoError: null })
  })

  it('waitForFix: a fresh position right away, otherwise the next one (not the stale one it already had)', async () => {
    useLocationStore.getState().setFix(fixAt(HERE))
    await expect(waitForFix()).resolves.toEqual(HERE)
    useLocationStore.setState({ fix: fixAt(HERE, Date.now() - 5 * 60_000) })
    const next = waitForFix()
    useLocationStore.getState().setFix(fixAt(THERE))
    await expect(next).resolves.toEqual(THERE)
  })

  it('waitForFix gives up at once when location is denied, and falls back to the last position on timeout', async () => {
    vi.useFakeTimers()
    const denied = waitForFix()
    useLocationStore.getState().setGeoError('geo_denied')
    await expect(denied).resolves.toBeNull()

    useLocationStore.setState({ fix: fixAt(HERE, Date.now() - 5 * 60_000), geoError: null })
    const quiet = waitForFix(1000) // a stationary phone may not report again
    vi.advanceTimersByTime(1000)
    await expect(quiet).resolves.toEqual(HERE)
  })
})
