import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_IDS } from '../data/systems'
import { parseLaunchParams } from '../lib/urlParams'
import { useRideStore } from '../ride/rideStore'
import { initialAppState, useAppStore } from '../store/appStore'
import { openLaunchParams } from './launchParams'

const open = (search: string) => openLaunchParams(parseLaunchParams(search, SYSTEM_IDS))
const sharedRide = '?system=bcycle_madison&start=bcycle_madison_1&toName=Memorial_Union&to=43.07652,-89.4003'

describe('opening a link', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialAppState, systemId: 'bcycle_madison' })
    useRideStore.getState().reset()
  })
  afterEach(() => useRideStore.getState().reset())

  it('a shared ride replaces the plan on screen and opens the planner', () => {
    useRideStore.getState().setStart('bcycle_madison_9')
    open(sharedRide)
    expect(useRideStore.getState()).toMatchObject({ startId: 'bcycle_madison_1', destination: { name: 'Memorial Union', coord: [-89.4003, 43.07652] } })
    expect(useAppStore.getState().panel).toBe('ride')
  })

  it('never ends a ride under way: a shared ride opens as a pin, and another city’s link is left unopened', () => {
    const startedAt = Date.now() - 5 * 60_000
    useRideStore.setState({ startId: 'bcycle_madison_9', openedParts: [0], rideStartedAtMs: startedAt })
    open(sharedRide)
    expect(useRideStore.getState()).toMatchObject({ startId: 'bcycle_madison_9', openedParts: [0], rideStartedAtMs: startedAt })
    expect(useAppStore.getState()).toMatchObject({ panel: 'pin', pin: [-89.4003, 43.07652] })

    open('?system=bcycle_boulder&station=bcycle_boulder_1')
    expect(useAppStore.getState().systemId).toBe('bcycle_madison')
    expect(useRideStore.getState()).toMatchObject({ openedParts: [0], rideStartedAtMs: startedAt })

    // A dock in the same city opens as usual.
    open('?system=bcycle_madison&station=bcycle_madison_2')
    expect(useAppStore.getState()).toMatchObject({ panel: 'station', selectedStationId: 'bcycle_madison_2' })
  })
})
