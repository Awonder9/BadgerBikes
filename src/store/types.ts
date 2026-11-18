// Client state contracts. Ownership rules:
//   • React Query owns server data (/api/stations, /api/system, geocoding). Stores never copy station objects.
//   • useAppStore (persisted subset) owns ids, UI state and settings; useRideStore owns the ride plan;
//     useLocationStore owns the rider's position.
//   • Selectors returning objects/arrays must use zustand's useShallow.
import type { LngLat, MapMode, Place, Units } from '../types'

export interface PassChoice {
  /** system_pricing_plans plan_id, or null for "Not sure" (uses SystemDetails.defaultIncludedMinutes). */
  planId: string | null
  includedMinutes: number | null
}

export interface Settings {
  units: Units
  /** 1–4 riders. */
  partySize: number
  mapStyle: 'auto' | 'light' | 'dark'
  /** Rider confirmed "I have the BCycle app and a pass" (removes the first-ride overhead). */
  setupConfirmed: boolean
  /** The first-visit "add to home screen" pop-up was shown and dismissed. */
  installTipSeen: boolean
  passBySystem: Record<string, PassChoice>
}

export interface SavedPlace {
  id: string
  systemId: string
  icon: 'home' | 'work' | 'star'
  label: string
  place: Place
}

export type Panel = 'browse' | 'station' | 'pin' | 'ride' | 'list' | 'settings' | 'about'
export type SheetSnap = 'peek' | 'half' | 'full'

export interface AppState {
  systemId: string | null
  mapMode: MapMode
  selectedStationId: string | null
  pin: LngLat | null
  panel: Panel
  sheet: SheetSnap
  settings: Settings
  savedPlaces: SavedPlace[]
  /** Keys `${systemId}:${stationId}`. */
  starredStations: string[]
  /** Most recent first, max 8. */
  recentPlaces: Place[]
  /** "Tell me when a bike/dock frees up" while the app is open. */
  /** `baseline` = the count when watching started; the alert fires when more than that are free. */
  watchedStation: { stationId: string; want: 'bikes' | 'docks'; baseline: number } | null
}

export interface AppActions {
  /** Switches city (registry ids only); clears selection and pin. */
  setSystem(id: string): boolean
  setMapMode(mode: MapMode): void
  selectStation(id: string | null): void
  dropPin(coord: LngLat | null): void
  setPanel(panel: Panel): void
  setSheet(snap: SheetSnap): void
  updateSettings(patch: Partial<Settings>): void
  setPassChoice(systemId: string, choice: PassChoice): void
  savePlace(place: Omit<SavedPlace, 'id'>): void
  removeSavedPlace(id: string): void
  toggleStar(systemId: string, stationId: string): void
  pushRecent(place: Place): void
  watchStation(watch: AppState['watchedStation']): void
}
