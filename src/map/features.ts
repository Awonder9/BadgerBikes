// Pure GeoJSON builders for the map layers (no maplibre runtime imports — unit-testable in Node).
import { destination, lineLength } from '../lib/geo'
import { sliceRoute } from '../ride/gpx'
import { classifyStation } from '../lib/stationState'
import type { PathKind } from '../routing/details'
import type { GeoFix, LngLat, RouteLeg, StationsSnapshot } from '../types'
import type { StationFeatureProps } from './types'

type Geometry = { type: 'Point'; coordinates: LngLat } | { type: 'LineString'; coordinates: LngLat[] } | { type: 'Polygon'; coordinates: LngLat[][] }
export interface Feature<P> {
  type: 'Feature'
  id?: string
  geometry: Geometry
  properties: P
}
export interface FeatureCollection<P> {
  type: 'FeatureCollection'
  features: Feature<P>[]
}

const EMPTY = { type: 'FeatureCollection', features: [] } as const
export const emptyCollection = <P>(): FeatureCollection<P> => ({ ...EMPTY, features: [] })

export type StationRoles = ReadonlyMap<string, StationFeatureProps['planRole']>

/** Start dock = 'pickup', ride end = 'dropoff', intermediate stops = 'backup'. */
export function rideRoles(startId: string | null, stopIds: readonly string[]): StationRoles {
  const m = new Map<string, StationFeatureProps['planRole']>()
  stopIds.forEach((id, i) => m.set(id, i === stopIds.length - 1 ? 'dropoff' : 'backup'))
  if (startId) m.set(startId, 'pickup')
  return m
}

export function buildStationFeatures(s: StationsSnapshot, opts: { partySize: number; starred: ReadonlySet<string>; roles: StationRoles }): FeatureCollection<StationFeatureProps> {
  const role = (id: string): StationFeatureProps['planRole'] => opts.roles.get(id) ?? ''
  return {
    type: 'FeatureCollection',
    features: s.stations.map((st) => {
      const a = classifyStation(st, opts.partySize)
      return {
        type: 'Feature',
        id: st.id,
        geometry: { type: 'Point', coordinates: st.coord },
        properties: {
          id: st.id,
          bikes: st.status?.bikes ?? 0,
          docks: st.status?.docks ?? 0,
          ebikes: st.status?.ebikes ?? -1,
          bikeState: a.bikeState,
          ebikeState: a.ebikeState ?? a.bikeState,
          dockState: a.dockState,
          starred: opts.starred.has(st.id),
          planRole: role(st.id),
        },
      }
    }),
  }
}

export interface RouteProps {
  mode: 'walk' | 'bike'
  role: RouteLeg['role']
  /** 1 for legs drawn faded (route options not chosen). */
  done: number
  /** 1 = a preview only (the chosen option lets Google Maps pick the streets): drawn thin and translucent. */
  light: number
  /** 1 = a multi-stop trip's finished leg: drawn in one muted color, under the leg on screen. */
  past: number
}

/** `completedBefore`: the first legs are drawn faded; `light`: every leg is drawn as a preview. */
export function buildRouteFeatures(legs: readonly RouteLeg[], completedBefore = 0, light = false): FeatureCollection<RouteProps> {
  return {
    type: 'FeatureCollection',
    features: legs.map((l, i) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.geometry }, properties: { mode: l.mode, role: l.role, done: i < completedBefore ? 1 : 0, light: light ? 1 : 0, past: 0 } })),
  }
}

/** A multi-stop trip's finished legs (rideStore.pastLegs). */
export function buildPastLegFeatures(lines: ReadonlyArray<readonly LngLat[]>): FeatureCollection<RouteProps>['features'] {
  return lines.map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...l] }, properties: { mode: 'bike', role: 'ride', done: 0, light: 0, past: 1 } }))
}

export interface EndpointProps {
  kind: 'origin' | 'pickup' | 'dropoff' | 'destination' | 'tripStop'
  label: string
}

/**
 * Start (when it isn't a dock) and destination markers; dock ends are shown by the station rings. `tripStops`: a
 * multi-stop trip's other stops (the leg on screen's own ends are drawn as start and destination).
 */
export function buildEndpointFeatures(dest: LngLat | null, origin: LngLat | null = null, tripStops: readonly LngLat[] = []): FeatureCollection<EndpointProps> {
  const features: FeatureCollection<EndpointProps>['features'] = tripStops.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'tripStop', label: '' } }))
  if (origin) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: origin }, properties: { kind: 'origin', label: '' } })
  if (dest) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: dest }, properties: { kind: 'destination', label: '' } })
  return { type: 'FeatureCollection', features }
}

/** Path-kind segments (in route order) up to `toMeters` along them: the colored line stops at the end dock. */
export function clipSegments<S extends { coords: LngLat[] }>(segments: readonly S[], toMeters: number): S[] {
  const out: S[] = []
  let at = 0
  for (const s of segments) {
    if (at >= toMeters) break
    const len = lineLength(s.coords)
    out.push(at + len <= toMeters ? s : { ...s, coords: sliceRoute(s.coords, toMeters - at) })
    at += len
  }
  return out
}

/** The chosen route split by kind of way (colored on the map). */
export function buildPathKindFeatures(segments: ReadonlyArray<{ kind: PathKind; coords: LngLat[] }>): FeatureCollection<{ kind: PathKind }> {
  return { type: 'FeatureCollection', features: segments.map((s) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.coords }, properties: { kind: s.kind } })) }
}

/** Walking legs as dashed lines (start → pickup dock, end dock → destination): routed, or straight until then. */
export function buildWalkFeatures(walks: ReadonlyArray<readonly LngLat[]>): FeatureCollection<RouteProps>['features'] {
  return walks.map((w) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...w] }, properties: { mode: 'walk', role: 'toPickup', done: 0, light: 0, past: 0 } }))
}

export interface UserProps {
  part: 'accuracy' | 'puck'
  quality: 'good' | 'degraded' | 'poor'
  heading: number
  hasHeading: number
}

/** Accuracy polygon + puck point for the user location. */
export function buildUserFeatures(fix: GeoFix | null, quality: UserProps['quality'], heading: number | null): FeatureCollection<UserProps> {
  if (!fix) return emptyCollection()
  const ring: LngLat[] = []
  const r = Math.max(3, fix.accuracy)
  for (let i = 0; i <= 32; i++) ring.push(destination(fix.coord, r, (i * 360) / 32))
  const props = { quality, heading: heading ?? 0, hasHeading: heading === null ? 0 : 1 }
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { part: 'accuracy', ...props } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: fix.coord }, properties: { part: 'puck', ...props } },
    ],
  }
}

export interface SavedPlaceProps {
  /** SavedPlace id (a tap looks the place up by it). */
  id: string
  icon: 'home' | 'work' | 'star'
}

/** Home, Work and favorite places of this city as map points (markers drawn by the saved-places layer). */
export function buildSavedPlaceFeatures(saved: ReadonlyArray<{ id: string; systemId: string; icon: SavedPlaceProps['icon']; place: { coord: LngLat } }>, systemId: string | null): FeatureCollection<SavedPlaceProps> {
  return {
    type: 'FeatureCollection',
    features: saved
      .filter((p) => p.systemId === systemId)
      .map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.place.coord }, properties: { id: p.id, icon: p.icon } })),
  }
}
