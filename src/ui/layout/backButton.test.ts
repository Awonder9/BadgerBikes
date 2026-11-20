import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store/appStore'
import { goBack } from './backButton'

const back = () => goBack(useAppStore.getState())
const state = () => {
  const s = useAppStore.getState()
  return { panel: s.panel, selected: s.selectedStationId, pin: s.pin }
}

beforeEach(() => {
  useAppStore.setState({ panel: 'browse', selectedStationId: null, pin: null, sheet: 'half' })
})

describe('the Android back button', () => {
  it('closes a station’s card or a dropped pin, like their Back and Close buttons', () => {
    useAppStore.getState().selectStation('s1')
    expect([back(), state()]).toEqual([true, { panel: 'browse', selected: null, pin: null }])
    useAppStore.getState().dropPin([-89.4, 43.07])
    expect([back(), state()]).toEqual([true, { panel: 'browse', selected: null, pin: null }])
  })

  it('goes back one level at a time: About → Settings → the map', () => {
    useAppStore.getState().setPanel('about')
    expect([back(), state().panel]).toEqual([true, 'settings'])
    expect([back(), state().panel]).toEqual([true, 'browse'])
  })

  it('leaves the ride planner and the station list for the map (the plan stays)', () => {
    for (const panel of ['ride', 'list'] as const) {
      useAppStore.getState().setPanel(panel)
      expect([back(), state().panel]).toEqual([true, 'browse'])
    }
  })

  it('has nothing left to close on the map itself (the app goes to the background)', () => {
    expect(back()).toBe(false)
  })
})
