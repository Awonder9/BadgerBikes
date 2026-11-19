import { beforeEach, describe, expect, it } from 'vitest'
import { initialAppState, sanitizePersisted, useAppStore } from './appStore'
import { DEFAULT_SETTINGS } from './validate'

const place = (name: string, lon = -89.4, lat = 43.07) => ({ kind: 'search' as const, name, coord: [lon, lat] as [number, number] })

describe('sanitizePersisted', () => {
  it('drops corrupt or unknown values piece by piece', () => {
    const s = sanitizePersisted({
      systemId: 'bcycle_nope',
      settings: { units: 'furlongs', partySize: 99, mapStyle: 'neon', installTipSeen: true, passBySystem: { bcycle_madison: { planId: 'x', includedMinutes: 30 }, 'bad key!': {} } },
      savedPlaces: [{ id: 'a', systemId: 'bcycle_madison', label: 'Home', icon: 'home', place: place('Home') }, { junk: true }],
      starredStations: ['bcycle_madison:bcycle_madison_1', 42, '<script>'],
      recentPlaces: [place('A'), { kind: 'search', name: 'bad', coord: [500, 0] }],
    })
    expect(s.systemId).toBeNull() // unknown id → chosen again at launch
    expect(s.settings).toMatchObject({ units: 'imperial', partySize: 4, mapStyle: DEFAULT_SETTINGS.mapStyle, installTipSeen: true })
    expect(s.settings.passBySystem).toEqual({ bcycle_madison: { planId: 'x', includedMinutes: 30 } })
    expect(s.savedPlaces).toHaveLength(1)
    expect(s.starredStations).toEqual(['bcycle_madison:bcycle_madison_1'])
    expect(s.recentPlaces.map((p) => p.name)).toEqual(['A'])
    expect(sanitizePersisted('garbage').settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('useAppStore actions', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialAppState })
  })

  it('switches to registry cities only', () => {
    useAppStore.setState({ panel: 'ride' })
    expect(useAppStore.getState().setSystem('bcycle_madison')).toBe(true) // first choice keeps the open panel
    expect(useAppStore.getState()).toMatchObject({ systemId: 'bcycle_madison', panel: 'ride' })
    expect(useAppStore.getState().setSystem('bcycle_indego')).toBe(true) // a switch closes city-specific panels
    expect(useAppStore.getState()).toMatchObject({ systemId: 'bcycle_indego', panel: 'browse' })
    expect(useAppStore.getState().setSystem('not_a_system')).toBe(false)
    expect(useAppStore.getState().systemId).toBe('bcycle_indego')
  })


  it('keeps recent places unique, capped, and skips my-location', () => {
    const { pushRecent } = useAppStore.getState()
    for (let i = 0; i < 10; i++) pushRecent(place(`P${i}`, -89.4 + i * 0.001))
    pushRecent(place('P5', -89.4 + 5 * 0.001))
    pushRecent({ kind: 'myLocation', name: 'My location', coord: [-89.4, 43.07] })
    const names = useAppStore.getState().recentPlaces.map((p) => p.name)
    expect(names[0]).toBe('P5')
    expect(names).toHaveLength(8)
    expect(new Set(names).size).toBe(8)
    useAppStore.getState().clearRecent()
    expect(useAppStore.getState().recentPlaces).toEqual([])
  })

  it('toggles stars and replaces Home/Work saved places', () => {
    const s = useAppStore.getState()
    s.toggleStar('bcycle_madison', 'st1')
    expect(useAppStore.getState().starredStations).toEqual(['bcycle_madison:st1'])
    useAppStore.getState().toggleStar('bcycle_madison', 'st1')
    expect(useAppStore.getState().starredStations).toEqual([])
    useAppStore.getState().savePlace({ systemId: 'bcycle_madison', icon: 'home', label: 'Home', place: place('Old home') })
    useAppStore.getState().savePlace({ systemId: 'bcycle_madison', icon: 'home', label: 'Home', place: place('New home') })
    expect(useAppStore.getState().savedPlaces.map((p) => p.place.name)).toEqual(['New home'])
  })

  it('validates settings updates', () => {
    useAppStore.getState().updateSettings({ partySize: 0 })
    expect(useAppStore.getState().settings.partySize).toBe(1)
    expect(useAppStore.getState().settings.preferEbikes).toBe(false)
    useAppStore.getState().updateSettings({ preferEbikes: true })
    expect(useAppStore.getState().settings.preferEbikes).toBe(true)
    expect(sanitizePersisted({ settings: { preferEbikes: 'yes' } }).settings.preferEbikes).toBe(false)
    useAppStore.getState().setPassChoice('bcycle_madison', { planId: null, includedMinutes: 60 })
    expect(useAppStore.getState().settings.passBySystem.bcycle_madison).toEqual({ planId: null, includedMinutes: 60 })
  })
})
