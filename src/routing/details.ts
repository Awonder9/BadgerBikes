// Route details from Valhalla /trace_attributes: what kind of way each stretch is (path breakdown) and
// the elevation along it. Pure: no DOM, no network.
import { decodePolyline } from '../lib/polyline'
import type { LngLat } from '../types'
import { badResponse, finiteNumber, isRecord } from './normalize'

/** From most to least separated from car traffic. */
export type PathKind = 'bikePath' | 'sharedPath' | 'protectedLane' | 'bikeLane' | 'sharedLane' | 'quietStreet' | 'busyRoad'

export const PATH_KINDS: readonly PathKind[] = ['bikePath', 'sharedPath', 'protectedLane', 'bikeLane', 'sharedLane', 'quietStreet', 'busyRoad']

export const PATH_LABELS: Record<PathKind, string> = {
  bikePath: 'Bike path',
  sharedPath: 'Shared-use path',
  protectedLane: 'Protected bike lane',
  bikeLane: 'Bike lane',
  sharedLane: 'Shared lane',
  quietStreet: 'Quiet street',
  busyRoad: 'Road with traffic',
}

export interface RouteDetails {
  /** Meters per kind, largest first; kinds with no length are omitted. */
  breakdown: Array<{ kind: PathKind; meters: number }>
  /** null when the router has no elevation data for this area. */
  elevation: {
    gainM: number
    lossM: number
    minM: number
    maxM: number
    /** [meters along the route, elevation in meters] at each stretch's midpoint. */
    profile: Array<[number, number]>
  } | null
  /** The route as consecutive stretches of one kind each (for coloring the line on the map). */
  segments: Array<{ kind: PathKind; coords: LngLat[] }>
}

const PATH_USES = new Set(['path', 'footway', 'pedestrian', 'bridleway', 'mountain_bike', 'steps', 'sidewalk', 'pedestrian_crossing', 'elevator'])
const QUIET_CLASSES = new Set(['residential', 'service_other', 'living_street'])
const QUIET_USES = new Set(['living_street', 'parking_aisle', 'driveway', 'alley', 'service_road', 'culdesac', 'track'])
/** Valhalla's "no elevation data" value. */
const NO_DATA = -32768
/** Ignore elevation changes smaller than this (noise between short stretches). */
const DEAD_BAND_M = 3

export function classifyEdge(e: { use?: unknown; cycle_lane?: unknown; road_class?: unknown }): PathKind {
  const use = typeof e.use === 'string' ? e.use : ''
  if (use === 'cycleway') return 'bikePath'
  if (PATH_USES.has(use)) return 'sharedPath'
  if (e.cycle_lane === 'separated') return 'protectedLane'
  if (e.cycle_lane === 'dedicated') return 'bikeLane'
  if (e.cycle_lane === 'shared') return 'sharedLane'
  if (QUIET_USES.has(use) || QUIET_CLASSES.has(typeof e.road_class === 'string' ? e.road_class : '')) return 'quietStreet'
  return 'busyRoad'
}

/** /trace_attributes JSON (edge.length in the response `units`) → RouteDetails. */
export function normalizeTraceAttributes(json: unknown): RouteDetails {
  if (!isRecord(json) || !Array.isArray(json.edges)) throw badResponse('valhalla', 'no edges')
  const perKm = json.units === 'miles' ? 1609.344 : 1000
  const meters = new Map<PathKind, number>()
  const profile: Array<[number, number]> = []
  let along = 0
  for (const raw of json.edges) {
    if (!isRecord(raw)) continue
    const len = (finiteNumber(raw.length) ?? 0) * perKm
    if (len <= 0) continue
    const kind = classifyEdge(raw)
    meters.set(kind, (meters.get(kind) ?? 0) + len)
    const ele = finiteNumber(raw.mean_elevation)
    if (ele !== undefined && ele > NO_DATA + 1) profile.push([along + len / 2, ele])
    along += len
  }
  const segments = buildSegments(json)
  const breakdown = [...meters.entries()].map(([kind, m]) => ({ kind, meters: m })).sort((a, b) => b.meters - a.meters)
  return { breakdown, elevation: profile.length >= 2 ? elevationSummary(profile) : null, segments }
}

/** Matched shape split at each edge's shape indices; neighbouring edges of the same kind are merged. */
function buildSegments(json: Record<string, unknown>): RouteDetails['segments'] {
  if (typeof json.shape !== 'string' || !Array.isArray(json.edges)) return []
  let shape: LngLat[]
  try {
    shape = decodePolyline(json.shape, 6)
  } catch {
    return []
  }
  const out: RouteDetails['segments'] = []
  for (const raw of json.edges) {
    if (!isRecord(raw)) continue
    const b = finiteNumber(raw.begin_shape_index)
    const e = finiteNumber(raw.end_shape_index)
    if (b === undefined || e === undefined || e <= b || e >= shape.length) continue
    const kind = classifyEdge(raw)
    const coords = shape.slice(b, e + 1)
    const last = out.at(-1)
    if (last && last.kind === kind) last.coords.push(...coords.slice(1))
    else out.push({ kind, coords })
  }
  return out
}

function elevationSummary(profile: Array<[number, number]>): NonNullable<RouteDetails['elevation']> {
  let gainM = 0
  let lossM = 0
  let ref = profile[0]![1]
  let minM = ref
  let maxM = ref
  for (const [, e] of profile) {
    minM = Math.min(minM, e)
    maxM = Math.max(maxM, e)
    if (e - ref >= DEAD_BAND_M) {
      gainM += e - ref
      ref = e
    } else if (ref - e >= DEAD_BAND_M) {
      lossM += ref - e
      ref = e
    }
  }
  return { gainM, lossM, minM, maxM, profile }
}
