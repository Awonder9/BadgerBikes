// Pure GeoJSON builders for the map layers (no maplibre runtime imports — unit-testable in Node).
import { destination } from '../lib/geo'
import { classifyStation } from '../lib/stationState'
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
  /** 1 for legs already completed during navigation (drawn faded). */
  done: number
}

export function buildRouteFeatures(legs: readonly RouteLeg[], completedBefore = 0): FeatureCollection<RouteProps> {
  return {
    type: 'FeatureCollection',
    features: legs.map((l, i) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.geometry }, properties: { mode: l.mode, role: l.role, done: i < completedBefore ? 1 : 0 } })),
  }
}

export interface EndpointProps {
  kind: 'origin' | 'pickup' | 'dropoff' | 'destination'
  label: string
}

/** Destination marker (dock ends are shown by the station rings). */
export function buildEndpointFeatures(destination: LngLat | null): FeatureCollection<EndpointProps> {
  if (!destination) return emptyCollection()
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: destination }, properties: { kind: 'destination', label: '' } }] }
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
