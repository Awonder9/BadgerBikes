// Provider-neutral leg normalization (docs/ARCHITECTURE.md §6): length units → meters, polyline6
// decoding, connectors to the requested points, consecutive-duplicate removal with index remapping, and
// the RouteLeg invariants from src/types.ts that every provider's output must satisfy.
import { ROUTING } from '../config'
import { AppError } from '../lib/errors'
import { haversine, isValidLngLat } from '../lib/geo'
import { decodePolyline } from '../lib/polyline'
import { speedMps } from './estimates'
import type { LegRole, LngLat, Maneuver, Provider, RouteLeg, TravelMode, Units } from '../types'
import type { BikeKind } from './types'

/** A requested point farther than this from the snapped endpoint gets a straight connector (ROUTING in src/config.ts). */
export const CONNECTOR_MIN_METERS = ROUTING.connectorMinMeters

export const METERS_PER_MILE = 1609.344
export const METERS_PER_KILOMETER = 1000

/** Length units used by Valhalla (`trip.units`, matrix `units`). */
export type LengthUnit = 'miles' | 'kilometers'

/** Converts a router length in `unit` to meters. */
export function toMeters(length: number, unit: LengthUnit): number {
  return length * (unit === 'miles' ? METERS_PER_MILE : METERS_PER_KILOMETER)
}

/** Decodes a Valhalla shape (encoded polyline, precision 6) into [lon, lat] points. */
export function decodeShape6(shape: string): LngLat[] {
  return decodePolyline(shape, 6)
}

// ─── Untrusted JSON helpers ──────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Non-negative integer, or undefined. */
export function indexValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Trimmed string with internal whitespace runs collapsed; undefined when empty or not a string. */
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : undefined
}

export function badResponse(provider: string, message: string): AppError {
  return new AppError('bad_response', `${provider}: ${message}`, { provider })
}

// ─── Leg assembly ────────────────────────────────────────────────────────────────────────────────

/** A maneuver before finalization; `location` is derived from the final geometry. */
export type DraftManeuver = Omit<Maneuver, 'location'>

/** A provider's leg as returned (snapped endpoints), with maneuver indices into `geometry`. */
export interface DraftLeg {
  geometry: LngLat[]
  maneuvers: DraftManeuver[]
  /** Meters, excluding connectors. */
  distance: number
  /** Seconds, excluding connectors. */
  duration: number
}

/** Request-derived fields copied onto the leg. */
export interface LegContext {
  provider: Provider
  role: LegRole
  mode: TravelMode
  /** Requested start/end (station coordinate or user point). */
  from: LngLat
  to: LngLat
  /** Units/language the verbal text was generated in. */
  units: Units
  language: string
  stationId?: string
  /** Speed model for connector durations (bike legs). */
  bikeKind?: BikeKind
}

/**
 * Removes consecutive identical points. `indexMap[i]` is the index in the returned geometry of original
 * point i (a dropped duplicate maps to the point it repeated), so maneuver indices can be remapped.
 */
export function removeConsecutiveDuplicates(geometry: readonly LngLat[]): { geometry: LngLat[]; indexMap: number[] } {
  const out: LngLat[] = []
  const indexMap: number[] = []
  for (const point of geometry) {
    const last = out[out.length - 1]
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point)
    indexMap.push(out.length - 1)
  }
  return { geometry: out, indexMap }
}

/** Structural problems in a provider's draft (indices out of range, broken chain, bad numbers). */
function draftViolations(draft: DraftLeg): string[] {
  const problems: string[] = []
  const { geometry, maneuvers } = draft
  if (geometry.length === 0) problems.push('empty geometry')
  if (!geometry.every((p) => isValidLngLat(p))) problems.push('invalid coordinate in geometry')
  if (maneuvers.length < 2) problems.push('fewer than 2 maneuvers')
  if (!(draft.distance >= 0) || !(draft.duration >= 0)) problems.push('invalid leg distance/duration')
  const last = geometry.length - 1
  maneuvers.forEach((m, i) => {
    if (!Number.isInteger(m.beginIndex) || !Number.isInteger(m.endIndex) || m.beginIndex < 0 || m.endIndex > last || m.beginIndex > m.endIndex) {
      problems.push(`maneuver ${i}: indices [${m.beginIndex}, ${m.endIndex}] outside [0, ${last}]`)
    }
    const next = maneuvers[i + 1]
    if (next && m.endIndex !== next.beginIndex) problems.push(`maneuver ${i}: endIndex ${m.endIndex} !== next beginIndex ${next.beginIndex}`)
    if (!(m.distance >= 0) || !(m.duration >= 0)) problems.push(`maneuver ${i}: invalid distance/duration`)
  })
  const first = maneuvers[0]
  if (first && first.beginIndex !== 0) problems.push('first maneuver does not begin at 0')
  const arrive = maneuvers[maneuvers.length - 1]
  if (arrive && (arrive.kind !== 'arrive' || arrive.beginIndex !== last || arrive.endIndex !== last)) {
    problems.push('last maneuver is not an arrive at the last geometry index')
  }
  return problems
}

/**
 * Turns a provider draft into a RouteLeg that satisfies every invariant in src/types.ts:
 *   1. rejects structurally broken drafts with AppError('bad_response');
 *   2. removes consecutive duplicate points and remaps maneuver indices;
 *   3. prepends `from` / appends `to` as connectors when the router snapped them more than
 *      CONNECTOR_MIN_METERS away (indices shifted; the first / last-but-arrive maneuver and the leg grow by the
 *      connector's length and its duration at the mode's speed); snapFromM/snapToM are always recorded;
 *   4. derives every maneuver `location` from the final geometry.
 * A leg left with fewer than 2 distinct points (endpoints within a few meters of one snapped point) rejects
 * with AppError('no_route') so the router can fall back to a straight leg.
 */
export function finalizeLeg(draft: DraftLeg, ctx: LegContext): RouteLeg {
  const problems = draftViolations(draft)
  if (problems.length > 0) throw badResponse(ctx.provider, `malformed route (${problems.join('; ')})`)

  const deduped = removeConsecutiveDuplicates(draft.geometry)
  let geometry = deduped.geometry
  let maneuvers: DraftManeuver[] = draft.maneuvers.map((m) => ({
    ...m,
    beginIndex: deduped.indexMap[m.beginIndex] ?? 0,
    endIndex: deduped.indexMap[m.endIndex] ?? 0,
  }))

  const speed = speedMps(ctx.mode, ctx.bikeKind)
  const snapFromM = haversine(ctx.from, geometry[0]!)
  const snapToM = haversine(geometry[geometry.length - 1]!, ctx.to)
  let distance = draft.distance
  let duration = draft.duration

  if (snapFromM > CONNECTOR_MIN_METERS) {
    geometry = [ctx.from, ...geometry]
    maneuvers = maneuvers.map((m, i) =>
      i === 0
        ? { ...m, beginIndex: 0, endIndex: m.endIndex + 1, distance: m.distance + snapFromM, duration: m.duration + snapFromM / speed }
        : { ...m, beginIndex: m.beginIndex + 1, endIndex: m.endIndex + 1 },
    )
    distance += snapFromM
    duration += snapFromM / speed
  }
  if (snapToM > CONNECTOR_MIN_METERS) {
    geometry = [...geometry, ctx.to]
    const lastIndex = geometry.length - 1
    const arriveIndex = maneuvers.length - 1
    maneuvers = maneuvers.map((m, i) => {
      if (i === arriveIndex) return { ...m, beginIndex: lastIndex, endIndex: lastIndex }
      if (i === arriveIndex - 1) return { ...m, endIndex: lastIndex, distance: m.distance + snapToM, duration: m.duration + snapToM / speed }
      return m
    })
    distance += snapToM
    duration += snapToM / speed
  }

  if (geometry.length < 2) {
    throw new AppError('no_route', `${ctx.provider}: route has fewer than 2 distinct points`, { provider: ctx.provider })
  }

  const leg: RouteLeg = {
    role: ctx.role,
    mode: ctx.mode,
    from: ctx.from,
    to: ctx.to,
    geometry,
    snapFromM,
    snapToM,
    distance,
    duration,
    maneuvers: maneuvers.map((m) => ({ ...m, location: geometry[m.beginIndex]! })),
    provider: ctx.provider,
    units: ctx.units,
    language: ctx.language,
    ...(ctx.stationId !== undefined ? { stationId: ctx.stationId } : {}),
  }
  const violations = legInvariantViolations(leg)
  if (violations.length > 0) throw badResponse(ctx.provider, `route violates leg invariants (${violations.join('; ')})`)
  return leg
}

// ─── Invariants ──────────────────────────────────────────────────────────────────────────────────

const SNAP_TOLERANCE_M = 1e-6

/** Every violated RouteLeg invariant (src/types.ts), as human-readable strings; empty when the leg is valid. */
export function legInvariantViolations(leg: RouteLeg): string[] {
  const problems: string[] = []
  const g = leg.geometry
  const last = g.length - 1
  if (g.length < 2) problems.push(`geometry has ${g.length} point(s), needs >= 2`)
  g.forEach((p, i) => {
    if (!isValidLngLat(p)) problems.push(`geometry[${i}] is not a valid [lon, lat]`)
    const prev = g[i - 1]
    if (prev && prev[0] === p[0] && prev[1] === p[1]) problems.push(`geometry[${i}] duplicates geometry[${i - 1}]`)
  })
  const first = g[0]
  const end = g[last]
  if (first && haversine(first, leg.from) > CONNECTOR_MIN_METERS + SNAP_TOLERANCE_M) problems.push('geometry[0] is not within the connector threshold of `from`')
  if (end && haversine(end, leg.to) > CONNECTOR_MIN_METERS + SNAP_TOLERANCE_M) problems.push('geometry[last] is not within the connector threshold of `to`')
  if (!(leg.snapFromM >= 0) || !(leg.snapToM >= 0)) problems.push('snapFromM/snapToM must be finite and >= 0')
  if (!(leg.distance >= 0) || !Number.isFinite(leg.distance) || !(leg.duration >= 0) || !Number.isFinite(leg.duration)) {
    problems.push('leg distance/duration must be finite and >= 0')
  }

  const ms = leg.maneuvers
  if (ms.length === 0) problems.push('no maneuvers')
  if (ms[0] && ms[0].beginIndex !== 0) problems.push(`maneuvers[0].beginIndex is ${ms[0].beginIndex}, expected 0`)
  ms.forEach((m, i) => {
    if (!Number.isInteger(m.beginIndex) || !Number.isInteger(m.endIndex) || m.beginIndex < 0 || m.beginIndex > m.endIndex || m.endIndex > last) {
      problems.push(`maneuvers[${i}] has invalid indices [${m.beginIndex}, ${m.endIndex}]`)
    }
    const next = ms[i + 1]
    if (next && m.endIndex !== next.beginIndex) problems.push(`maneuvers[${i}].endIndex ${m.endIndex} !== maneuvers[${i + 1}].beginIndex ${next.beginIndex}`)
    const at = g[m.beginIndex]
    if (!at || m.location[0] !== at[0] || m.location[1] !== at[1]) problems.push(`maneuvers[${i}].location !== geometry[beginIndex]`)
    if (!(m.distance >= 0) || !Number.isFinite(m.distance) || !(m.duration >= 0) || !Number.isFinite(m.duration)) {
      problems.push(`maneuvers[${i}] distance/duration must be finite and >= 0`)
    }
    if (m.instruction.length === 0) problems.push(`maneuvers[${i}] has an empty instruction`)
  })
  const arrive = ms[ms.length - 1]
  if (arrive && (arrive.kind !== 'arrive' || arrive.beginIndex !== last || arrive.endIndex !== last)) {
    problems.push(`last maneuver must be 'arrive' with beginIndex === endIndex === ${last}`)
  }
  return problems
}

/** Throws an Error listing every violated RouteLeg invariant. Used by tests (and available to other modules' tests). */
export function assertLegInvariants(leg: RouteLeg): void {
  const problems = legInvariantViolations(leg)
  if (problems.length > 0) throw new Error(`RouteLeg invariants violated (${leg.provider}):\n  - ${problems.join('\n  - ')}`)
}
