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

  it('opening the planner grows a peeking sheet but never shrinks a full one', () => {
    startRideAt('a')
    expect(useAppStore.getState().sheet).toBe('half')
    useAppStore.getState().setSheet('full')
    startRideAt('b')
    expect(useAppStore.getState()).toMatchObject({ sheet: 'full', panel: 'ride' })
  })

  it('going back to browse from a full sheet shrinks it', () => {
    useAppStore.setState({ panel: 'ride', sheet: 'full' })
    useAppStore.getState().setPanel('browse')
    expect(useAppStore.getState().sheet).toBe('peek')
  })
})
