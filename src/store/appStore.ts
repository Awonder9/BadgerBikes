// App store: ids, UI state and settings. A small validated subset is
// persisted (system, settings, saved/starred/recent). Never holds station objects (React Query does).
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { SYSTEM_IDS } from '../data/systems'
import { safeStorage } from '../lib/storage'
import type { LngLat, Place } from '../types'
import type { AppActions, AppState, SavedPlace } from './types'
import { DEFAULT_SETTINGS, validatePlaces, validateSavedPlaces, validateSettings, validateStringIds } from './validate'

const MAX_RECENT = 8

function samePlace(a: Place, b: Place): boolean {
  return a.name === b.name && Math.abs(a.coord[0] - b.coord[0]) < 1e-5 && Math.abs(a.coord[1] - b.coord[1]) < 1e-5
}

/** The saved place of this kind at (about) this spot in this city, if any. */
export function findSavedPlace(saved: readonly SavedPlace[], systemId: string | null, icon: SavedPlace['icon'], coord: LngLat): SavedPlace | undefined {
  return saved.find((p) => p.systemId === systemId && p.icon === icon && Math.abs(p.place.coord[0] - coord[0]) < 1e-5 && Math.abs(p.place.coord[1] - coord[1]) < 1e-5)
}

let idCounter = 0
const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}`

export const initialAppState: AppState = {
  // null until chosen: the stored city, a ?system= link, or the city nearest the rider (see useDefaultCity).
  systemId: null,
  mapMode: 'bikes',
  selectedStationId: null,
  pin: null,
  panel: 'browse',
  sheet: 'peek',
  settings: DEFAULT_SETTINGS,
  savedPlaces: [],
  starredStations: [],
  recentPlaces: [],
  watchedStation: null,
}

type PersistedSlice = Pick<AppState, 'systemId' | 'settings' | 'savedPlaces' | 'starredStations' | 'recentPlaces'>

/** Validates a persisted slice piece by piece (unknown/corrupt values fall back to defaults). */
export function sanitizePersisted(persisted: unknown): PersistedSlice {
  const p = typeof persisted === 'object' && persisted !== null ? (persisted as Record<string, unknown>) : {}
  return {
    systemId: typeof p.systemId === 'string' && SYSTEM_IDS.has(p.systemId) ? p.systemId : null,
    settings: validateSettings(p.settings),
    savedPlaces: validateSavedPlaces(p.savedPlaces),
    starredStations: validateStringIds(p.starredStations, 200),
    recentPlaces: validatePlaces(p.recentPlaces, MAX_RECENT),
  }
}

export const useAppStore = create<AppState & AppActions>()(
  persist(
    (set, get) => ({
      ...initialAppState,

      setSystem: (id) => {
        if (!SYSTEM_IDS.has(id)) return false
        const prev = get()
        if (prev.systemId === id) return true
        // First choice at launch: keep whatever a link already opened (e.g. a shared ride).
        if (prev.systemId === null) {
          set({ systemId: id })
          return true
        }
        // Switching cities: station-specific panels close; others (e.g. Settings) stay open.
        const cityPanel = prev.panel === 'station' || prev.panel === 'pin' || prev.panel === 'ride'
        set({ systemId: id, selectedStationId: null, pin: null, watchedStation: null, ...(cityPanel ? { panel: 'browse' } : {}) })
        return true
      },
      setMapMode: (mapMode) => set({ mapMode }),
      selectStation: (selectedStationId) => set(selectedStationId ? { selectedStationId, pin: null, panel: 'station' } : { selectedStationId: null }),
      dropPin: (pin) => set(pin ? { pin, selectedStationId: null, panel: 'pin' } : { pin: null }),
      // Back to the small browse panel from a full-height sheet: shrink it so the map isn't left covered.
      setPanel: (panel) => set((s) => (panel === 'browse' && s.sheet === 'full' ? { panel, sheet: 'peek' } : { panel })),
      setSheet: (sheet) => set({ sheet }),
      updateSettings: (patch) => set((s) => ({ settings: validateSettings({ ...s.settings, ...patch }) })),
      setPassChoice: (systemId, choice) =>
        set((s) => ({ settings: validateSettings({ ...s.settings, passBySystem: { ...s.settings.passBySystem, [systemId]: choice } }) })),
      savePlace: (place) =>
        set((s) => {
          const others = place.icon === 'star' ? s.savedPlaces : s.savedPlaces.filter((p) => !(p.systemId === place.systemId && p.icon === place.icon))
          return { savedPlaces: validateSavedPlaces([...others, { ...place, id: newId() }]) }
        }),
      removeSavedPlace: (id) => set((s) => ({ savedPlaces: s.savedPlaces.filter((p) => p.id !== id) })),
      toggleStar: (systemId, stationId) =>
        set((s) => {
          const key = `${systemId}:${stationId}`
          return {
            starredStations: s.starredStations.includes(key) ? s.starredStations.filter((k) => k !== key) : validateStringIds([...s.starredStations, key], 200),
          }
        }),
      pushRecent: (place) =>
        set((s) => {
          if (place.kind === 'myLocation') return {}
          return { recentPlaces: [place, ...s.recentPlaces.filter((p) => !samePlace(p, place))].slice(0, MAX_RECENT) }
        }),
      clearRecent: () => set({ recentPlaces: [] }),
      watchStation: (watchedStation) => set({ watchedStation }),
    }),
    {
      name: 'bcycle.app',
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      partialize: (s): PersistedSlice => ({
        systemId: s.systemId,
        settings: s.settings,
        savedPlaces: s.savedPlaces,
        starredStations: s.starredStations,
        recentPlaces: s.recentPlaces,
      }),
      migrate: (persisted) => sanitizePersisted(persisted),
      merge: (persisted, current) => ({ ...current, ...sanitizePersisted(persisted) }),
    },
  ),
)
