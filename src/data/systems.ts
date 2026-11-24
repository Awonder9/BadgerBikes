// Client access to the committed BCycle systems registry (src/data/systems.json).
import { ROUTING, SYSTEM_DETECT } from '../config'
import { bboxContains, haversine, isValidLngLat } from '../lib/geo'
import type { BBox, BcycleSystem, LngLat } from '../types'
import raw from './systems.json'

function isBBox(v: unknown): v is BBox {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** Validates registry entries defensively (the JSON is generated, but never trust shapes blindly). */
function toSystem(v: unknown): BcycleSystem | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || !isBBox(o.bbox) || !isValidLngLat(o.center)) return null
  return {
    id: o.id,
    name: o.name,
    city: typeof o.city === 'string' ? o.city : '',
    url: typeof o.url === 'string' ? o.url : '',
    timezone: typeof o.timezone === 'string' ? o.timezone : 'America/Chicago',
    bbox: o.bbox,
    center: o.center,
    stationCount: typeof o.stationCount === 'number' ? o.stationCount : 0,
    active: typeof o.active === 'boolean' ? o.active : (typeof o.stationCount === 'number' ? o.stationCount > 0 : true),
    gbfsUrl: typeof o.gbfsUrl === 'string' ? o.gbfsUrl : '',
  }
}

export const SYSTEMS: readonly BcycleSystem[] = (raw as unknown[])
  .map(toSystem)
  .filter((s): s is BcycleSystem => s !== null)
  .sort((a, b) => a.name.localeCompare(b.name))

export const SYSTEM_IDS: ReadonlySet<string> = new Set(SYSTEMS.map((s) => s.id))

const byId = new Map(SYSTEMS.map((s) => [s.id, s]))

export function getSystem(id: string | null | undefined): BcycleSystem | null {
  return id ? (byId.get(id) ?? null) : null
}

/** `coord` is within reach of the city's stations (ROUTING.maxOutsideSystemMeters): where its rides can go. */
export const withinReach = (sys: BcycleSystem, coord: LngLat): boolean => bboxContains(sys.bbox, coord, ROUTING.maxOutsideSystemMeters)

/** Within reach of any BCycle city's stations (a dropped pin worth naming). */
export const nearAnySystem = (coord: LngLat, systems: readonly BcycleSystem[] = SYSTEMS): boolean => systems.some((s) => withinReach(s, coord))


/**
 * The active system serving `coord`: its station area (bbox) padded by SYSTEM_DETECT.maxDistanceMeters,
 * preferring the closest center. Null when no BCycle system is near.
 */
export function nearestSystem(coord: LngLat, systems: readonly BcycleSystem[] = SYSTEMS): BcycleSystem | null {
  let best: BcycleSystem | null = null
  let bestD = Infinity
  for (const s of systems) {
    if (!s.active || !bboxContains(s.bbox, coord, SYSTEM_DETECT.maxDistanceMeters)) continue
    const d = haversine(coord, s.center)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return best
}
