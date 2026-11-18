// Shared test builders. Deterministic, no network. Coordinates default to downtown Madison.
import type { LngLat, Station, StationsSnapshot } from '../types'

export const MADISON = {
  capitol: [-89.3842, 43.07467] as LngLat,
  memorialUnion: [-89.4003, 43.07652] as LngLat,
  libraryMall: [-89.39955, 43.07487] as LngLat,
  wisconsinMifflin: [-89.38527, 43.07571] as LngLat,
}

let seq = 0

export interface StationOverrides {
  id?: string
  name?: string
  coord?: LngLat
  bikes?: number
  docks?: number
  /** Defaults to all-electric (Madison): ebikes = bikes, classic = 0. null = no type breakdown. */
  ebikes?: number | null
  classic?: number | null
  isInstalled?: boolean
  isRenting?: boolean
  isReturning?: boolean
  hasKiosk?: boolean
}

export function makeStation(o: StationOverrides = {}): Station {
  const n = ++seq
  const bikes = o.bikes ?? 5
  let ebikes: number | null
  let classic: number | null
  if (o.ebikes === null || o.classic === null) {
    ebikes = null
    classic = null
  } else if (o.ebikes !== undefined && o.classic !== undefined) {
    ebikes = o.ebikes
    classic = o.classic
  } else if (o.classic !== undefined) {
    classic = o.classic
    ebikes = Math.max(0, bikes - o.classic)
  } else if (o.ebikes !== undefined) {
    ebikes = o.ebikes
    classic = Math.max(0, bikes - o.ebikes)
  } else {
    ebikes = bikes
    classic = 0
  }
  return {
    id: o.id ?? `test_station_${n}`,
    name: o.name ?? `Station ${n}`,
    address: null,
    coord: o.coord ?? MADISON.capitol,
    regionId: null,
    hasKiosk: o.hasKiosk ?? true,
    rentalUris: { ios: null, android: null },
    status: {
      bikes,
      docks: o.docks ?? 5,
      ebikes,
      classic,
      isInstalled: o.isInstalled ?? true,
      isRenting: o.isRenting ?? true,
      isReturning: o.isReturning ?? true,
    },
  }
}

export function makeSnapshot(stations: Station[], o: { systemId?: string; lastUpdatedMs?: number; fetchedAtMs?: number } = {}): StationsSnapshot {
  const lastUpdatedMs = o.lastUpdatedMs ?? 1_800_000_000_000
  return {
    systemId: o.systemId ?? 'bcycle_madison',
    stations,
    byId: new Map(stations.map((s) => [s.id, s])),
    lastUpdatedMs,
    fetchedAtMs: o.fetchedAtMs ?? lastUpdatedMs + 1_000,
  }
}
