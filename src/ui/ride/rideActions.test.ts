import { beforeEach, describe, expect, it } from 'vitest'
import { useRideStore } from '../../ride/rideStore'
import { initialAppState, useAppStore } from '../../store/appStore'
import { rideMapTap, startRideAt } from './rideActions'

describe('ride actions', () => {
  beforeEach(() => {
    useRideStore.getState().reset()
    useAppStore.setState({ ...initialAppState })
  })

  it('a dock tapped on the map becomes the start, then the destination', () => {
    rideMapTap('a', 'Dock A', [-89.4, 43.07])
    expect(useRideStore.getState().startId).toBe('a')
    rideMapTap('a', 'Dock A', [-89.4, 43.07]) // tapping the start again changes nothing
    expect(useRideStore.getState().destination).toBeNull()
    rideMapTap('b', 'Dock B', [-89.38, 43.08])
    expect(useRideStore.getState().destination).toMatchObject({ kind: 'station', stationId: 'b', name: 'Dock B' })
  })

  it('mid-ride, a tapped dock opens its card instead of replacing the destination (and the ride progress)', () => {
    rideMapTap('a', 'Dock A', [-89.4, 43.07])
    rideMapTap('b', 'Dock B', [-89.38, 43.08])
    useRideStore.getState().markPartOpened(0, true)
    rideMapTap('c', 'Dock C', [-89.37, 43.08])
    expect(useRideStore.getState()).toMatchObject({ destination: { stationId: 'b' }, openedParts: [0] })
    expect(useAppStore.getState()).toMatchObject({ panel: 'station', selectedStationId: 'c' })
  })

  it('opening the planner grows a peeking sheet but never shrinks a full one', () => {
    startRideAt({ id: 'a', name: 'Dock A', coord: [-89.4, 43.07] })
    expect(useAppStore.getState().sheet).toBe('half')
    useAppStore.getState().setSheet('full')
    startRideAt({ id: 'b', name: 'Dock B', coord: [-89.38, 43.08] })
    expect(useAppStore.getState()).toMatchObject({ sheet: 'full', panel: 'ride' })
  })

  it('going back to browse from a full sheet shrinks it', () => {
    useAppStore.setState({ panel: 'ride', sheet: 'full' })
    useAppStore.getState().setPanel('browse')
    expect(useAppStore.getState().sheet).toBe('peek')
  })
})
