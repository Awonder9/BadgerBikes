// Map contract. MapView is mounted ONCE at the app root (layouts swap overlays only, so rotating the
// phone never recreates the WebGL context). It reads its own data (stations hook, stores) and exposes a
// small imperative API via a React 19 ref prop.
import type { Ref } from 'react'
import type { AppError } from '../lib/errors'
import type { AvailabilityState, BBox, LngLat } from '../types'

export interface Padding {
  top: number
  bottom: number
  left: number
  right: number
}

export interface Viewport {
  center: LngLat
  bbox: BBox
  zoom: number
}

export interface MapApi {
  flyTo(center: LngLat, opts?: { zoom?: number; durationMs?: number }): void
  fitBounds(bbox: BBox, opts?: { maxZoom?: number; durationMs?: number }): void
  /** Bottom sheet / side panel call this whenever they change size, so content is never hidden. */
  setPadding(padding: Padding): void
  getViewport(): Viewport | null
}

export interface MapViewProps {
  ref?: Ref<MapApi>
  /** Tap on a station marker. */
  onStationClick: (stationId: string) => void
  /** Tap on empty map. */
  onBackgroundClick: () => void
  /** Long-press (touch held 500 ms, < 10 px movement) or right-click: "choose this point". */
  onMapPick: (coord: LngLat) => void
  /** e.g. AppError('webgl_unavailable') → the UI shows the station list fallback. */
  onError: (err: AppError) => void
}

export const SOURCE_IDS = {
  stations: 'bc-stations',
  route: 'bc-route',
  routeKinds: 'bc-route-kinds',
  endpoints: 'bc-endpoints',
  user: 'bc-user',
  saved: 'bc-saved',
} as const

export const LAYER_IDS = {
  stationCircle: 'bc-station-circle',
  stationCount: 'bc-station-count',
  stationSelected: 'bc-station-selected',
  stationStarred: 'bc-station-starred',
  routeWalk: 'bc-route-walk',
  routeBikeCasing: 'bc-route-bike-casing',
  routeBike: 'bc-route-bike',
  routeKinds: 'bc-route-kinds',
  endpoints: 'bc-endpoints',
  endpointLabels: 'bc-endpoint-labels',
  savedPlaces: 'bc-saved-places',
  userAccuracy: 'bc-user-accuracy',
  userHeading: 'bc-user-heading',
  userPuck: 'bc-user-puck',
} as const

/**
 * Station feature properties are mode-independent: toggling Bikes/Docks only changes layer paint/layout
 * expressions, never the data. The source uses promoteId: 'id' so feature-state (selected) works with
 * BCycle's string ids.
 */
export interface StationFeatureProps {
  id: string
  bikes: number
  docks: number
  /** −1 when the feed has no breakdown (maplibre properties must be primitives). */
  ebikes: number
  bikeState: AvailabilityState
  dockState: AvailabilityState
  starred: boolean
  /** Role in the current plan, or '' (drives highlight rings). */
  planRole: 'pickup' | 'dropoff' | 'backup' | ''
}
