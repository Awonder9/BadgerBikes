// Ride history on this device: one record per BCycle ride the rider started from a plan (src/history/recorder.ts
// writes them). Feeds the weekly / monthly / yearly reviews (review.ts) and "Send to Strava" (strava*.ts).
// Pure: no DOM; times are injected.
//
// What a record knows: the plan (start dock, end dock, the route ridden — as planned, the app can't record GPS while
// Google Maps is in front), when the ride timer started, and when the ride ended — seen by the app (End ride, arrival,
// the next leg), or, when the app wasn't open then, estimated from the route's riding time (`endEstimated`).
import { HISTORY } from '../config'
import { haversine, isValidLngLat } from '../lib/geo'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import type { PathKind } from '../routing/details'
import { PATH_KINDS } from '../routing/details'
import type { LngLat } from '../types'

export interface RideRecord {
  id: string
  systemId: string
  /** When the BCycle ride started (the ride timer), epoch ms. */
  startedAtMs: number
  /** When it ended, epoch ms; null while the ride is under way. */
  endedAtMs: number | null
  /** The end wasn't seen: endedAtMs = start + the route's riding time. The rider can correct it. */
  endEstimated: boolean
  startName: string
  startStationId: string
  /** The dock the ride ends at (the plan's last stop). */
  endName: string
  endStationId: string | null
  /** Where the rider was going (null for "Just ride"). */
  destName: string | null
  /** Ridden distance (start dock → end dock along the route), meters, and the route's riding time, seconds. */
  meters: number
  plannedS: number
  electric: boolean
  /** "Just ride" (no destination) or a ride somewhere. */
  kind: 'ride' | 'loop'
  /** The route ridden, as planned (polyline6, thinned); dropped from older records (HISTORY.maxRidesWithLine). */
  line: string | null
  /** Meters per kind of way (when the path details were loaded) and the climb, meters. */
  pathM: Partial<Record<PathKind, number>>
  climbM: number | null
  /** "Just ride": the trails and places it passed (names). */
  highlights: string[]
  /** The Strava activity this ride was sent as. */
  stravaActivityId: string | null
}

/** Points at least `minMeters` apart, ends kept. */
export function thinLine(coords: readonly LngLat[], minMeters: number = HISTORY.lineThinMeters): LngLat[] {
  if (coords.length <= 2) return [...coords]
  const out: LngLat[] = [coords[0]!]
  for (let i = 1; i < coords.length - 1; i++) if (haversine(out.at(-1)!, coords[i]!) >= minMeters) out.push(coords[i]!)
  out.push(coords.at(-1)!)
  return out
}

export const encodeLine = (coords: readonly LngLat[]): string => encodePolyline(thinLine(coords), 6)

/** The record's route line, or null (none kept, or unreadable). */
export function decodeLine(line: string | null): LngLat[] | null {
  if (!line) return null
  try {
    const c = decodePolyline(line, 6)
    return c.length >= 2 && c.every(isValidLngLat) ? c : null
  } catch {
    return null
  }
}

/** Riding seconds of a finished ride (0 while under way). */
export const rideSecondsOf = (r: Pick<RideRecord, 'startedAtMs' | 'endedAtMs'>): number => (r.endedAtMs === null ? 0 : Math.max(0, (r.endedAtMs - r.startedAtMs) / 1000))

/**
 * When a ride ended, given when the app learned it was over. `seen`: the rider ended it in the app (End ride, arrival,
 * the next leg) — that moment, unless it is implausibly late for the route (the rider came back long after docking).
 * Not seen (the plan was gone when the app next opened): the route's riding time, estimated. Returns null for a ride
 * too short to have happened (a link opened and the ride ended at once: a mis-tap).
 */
export function rideEnd(startedAtMs: number, plannedS: number, nowMs: number, seen: boolean): { endedAtMs: number; endEstimated: boolean } | null {
  const elapsedMs = nowMs - startedAtMs
  if (seen && elapsedMs < HISTORY.minRideSeconds * 1000) return null
  const planned = { endedAtMs: startedAtMs + Math.max(HISTORY.minRideSeconds, Math.round(plannedS)) * 1000, endEstimated: true }
  if (!seen) return planned
  return elapsedMs <= plannedS * 1000 * HISTORY.lateEndFactor + HISTORY.lateEndSlackMs ? { endedAtMs: nowMs, endEstimated: false } : planned
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Stored text without control characters or angle brackets (it is only ever rendered as React text anyway). */
const text = (v: unknown, max = 120): string | null =>
  typeof v === 'string'
    ? Array.from(v)
        .filter((ch) => {
          const c = ch.codePointAt(0) ?? 0
          return c >= 0x20 && c !== 0x7f && ch !== '<' && ch !== '>'
        })
        .join('')
        .slice(0, max)
    : null

/** A stored record (storage is untrusted), or null. */
export function validateRide(v: unknown): RideRecord | null {
  if (!isObj(v)) return null
  const id = typeof v.id === 'string' && ID_RE.test(v.id) ? v.id : null
  const systemId = typeof v.systemId === 'string' && ID_RE.test(v.systemId) ? v.systemId : null
  const startName = text(v.startName)
  const endName = text(v.endName)
  const startStationId = typeof v.startStationId === 'string' && ID_RE.test(v.startStationId) ? v.startStationId : null
  if (!id || !systemId || startName === null || endName === null || !startStationId) return null
  if (!finite(v.startedAtMs) || v.startedAtMs <= 0 || !finite(v.meters) || v.meters < 0 || v.meters > 300_000 || !finite(v.plannedS) || v.plannedS < 0) return null
  const endedAtMs = v.endedAtMs === null ? null : finite(v.endedAtMs) && v.endedAtMs >= v.startedAtMs ? v.endedAtMs : undefined
  if (endedAtMs === undefined) return null
  const pathM: Partial<Record<PathKind, number>> = {}
  if (isObj(v.pathM)) for (const k of PATH_KINDS) if (finite(v.pathM[k]) && (v.pathM[k] as number) >= 0) pathM[k] = v.pathM[k] as number
  return {
    id,
    systemId,
    startedAtMs: v.startedAtMs,
    endedAtMs,
    endEstimated: v.endEstimated === true,
    startName,
    startStationId,
    endName,
    endStationId: typeof v.endStationId === 'string' && ID_RE.test(v.endStationId) ? v.endStationId : null,
    destName: text(v.destName),
    meters: v.meters,
    plannedS: v.plannedS,
    electric: v.electric === true,
    kind: v.kind === 'loop' ? 'loop' : 'ride',
    line: typeof v.line === 'string' && v.line.length <= 40_000 && /^[\x3f-\x7e]*$/.test(v.line) ? v.line : null,
    pathM,
    climbM: finite(v.climbM) && v.climbM >= 0 ? v.climbM : null,
    highlights: Array.isArray(v.highlights) ? v.highlights.map((h) => text(h, 80)).filter((h): h is string => !!h).slice(0, 8) : [],
    stravaActivityId: typeof v.stravaActivityId === 'string' && /^\d{1,24}$/.test(v.stravaActivityId) ? v.stravaActivityId : null,
  }
}

/** Newest first, at most HISTORY.maxRides, and only the newest HISTORY.maxRidesWithLine keep their line. */
export function capRides(rides: readonly RideRecord[]): RideRecord[] {
  return [...rides]
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, HISTORY.maxRides)
    .map((r, i) => (i < HISTORY.maxRidesWithLine || r.line === null ? r : { ...r, line: null }))
}
