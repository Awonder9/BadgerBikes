// Valhalla adapter: request builders, response normalizers, error mapping.
import { BIKE_ROUTING, SPEEDS } from '../config'
import { AppError } from '../lib/errors'
import type { LngLat, RouteLeg } from '../types'
import { valhallaKind, valhallaSide } from './maneuvers'
import { cleanText, decodeShape6, finalizeLeg, finiteNumber, indexValue, isRecord, toMeters, badResponse, type DraftManeuver, type LengthUnit } from './normalize'
import type { BikeKind, RouteRequest } from './types'

const PROVIDER = 'valhalla'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function costing(mode: 'walk' | 'bike', bikeKind: BikeKind = 'classic', useRoads: number = BIKE_ROUTING.defaultUseRoads) {
  if (mode === 'walk') return { costing: 'pedestrian', costing_options: { pedestrian: { walking_speed: SPEEDS.walkKph } } }
  return {
    costing: 'bicycle',
    costing_options: {
      bicycle: {
        bicycle_type: 'City',
        cycling_speed: SPEEDS.bikeKph[bikeKind],
        use_roads: clamp01(useRoads),
        use_living_streets: BIKE_ROUTING.useLivingStreets,
        avoid_bad_surfaces: BIKE_ROUTING.avoidBadSurfaces,
      },
    },
  }
}

const loc = (p: LngLat, extra: Record<string, unknown> = {}) => ({ lat: Number(p[1].toFixed(6)), lon: Number(p[0].toFixed(6)), ...extra })

export function routeBody(req: RouteRequest): Record<string, unknown> {
  const fromExtra: Record<string, unknown> = {}
  if (req.fromIsUserPoint) fromExtra.search_cutoff = BIKE_ROUTING.userPointSearchCutoffMeters
  if (req.headingDeg !== undefined) Object.assign(fromExtra, { heading: Math.round(req.headingDeg), heading_tolerance: 45 })
  return {
    locations: [
      loc(req.from, fromExtra),
      // Passed through without stopping or a U-turn, in one leg.
      ...(req.via ?? []).map((v) => loc(v.coord, { type: 'through', ...(v.searchCutoffMeters ? { search_cutoff: Math.round(v.searchCutoffMeters) } : {}) })),
      loc(req.to, req.toIsUserPoint ? { search_cutoff: BIKE_ROUTING.userPointSearchCutoffMeters } : {}),
    ],
    ...costing(req.mode, req.bikeKind, req.useRoads),
    directions_options: { units: req.units === 'imperial' ? 'miles' : 'kilometers', language: req.language },
  }
}

export const valhallaUrl = (base: string, endpoint: 'route', body: unknown) =>
  `${base}/${endpoint}?json=${encodeURIComponent(JSON.stringify(body))}`

/** Valhalla /route JSON → RouteLeg (all invariants enforced by finalizeLeg). */
export function normalizeValhallaRoute(json: unknown, req: RouteRequest): RouteLeg {
  const trip = isRecord(json) ? json.trip : undefined
  if (!isRecord(trip) || !Array.isArray(trip.legs)) throw badResponse(PROVIDER, 'no trip')
  const leg = trip.legs[0]
  if (!isRecord(leg) || typeof leg.shape !== 'string' || !Array.isArray(leg.maneuvers)) throw badResponse(PROVIDER, 'no leg')
  const unit: LengthUnit = trip.units === 'miles' ? 'miles' : 'kilometers'
  const geometry = decodeShape6(leg.shape)
  const maneuvers: DraftManeuver[] = []
  for (const raw of leg.maneuvers) {
    if (!isRecord(raw)) continue
    const type = finiteNumber(raw.type) ?? 0
    const m: DraftManeuver = {
      kind: valhallaKind(type),
      instruction: cleanText(raw.instruction) ?? '',
      distance: toMeters(finiteNumber(raw.length) ?? 0, unit),
      duration: finiteNumber(raw.time) ?? 0,
      beginIndex: indexValue(raw.begin_shape_index) ?? 0,
      endIndex: indexValue(raw.end_shape_index) ?? 0,
    }
    const alert = cleanText(raw.verbal_transition_alert_instruction)
    const pre = cleanText(raw.verbal_pre_transition_instruction)
    const post = cleanText(raw.verbal_post_transition_instruction)
    const succinct = cleanText(raw.verbal_succinct_transition_instruction)
    if (alert) m.verbalAlert = alert
    if (pre) m.verbalPre = pre
    if (post) m.verbalPost = post
    if (succinct) m.verbalSuccinct = succinct
    if (raw.verbal_multi_cue === true) m.verbalMultiCue = true
    if (Array.isArray(raw.street_names)) m.streetNames = raw.street_names.filter((s): s is string => typeof s === 'string')
    const exit = finiteNumber(raw.roundabout_exit_count)
    if (exit !== undefined) m.exitNumber = exit
    const side = valhallaSide(type)
    if (side) m.side = side
    const bearing = finiteNumber(raw.bearing_after)
    if (bearing !== undefined) m.bearingAfter = bearing
    maneuvers.push(m)
  }
  const summary = isRecord(leg.summary) ? leg.summary : {}
  return finalizeLeg(
    { geometry, maneuvers, distance: toMeters(finiteNumber(summary.length) ?? 0, unit), duration: finiteNumber(summary.time) ?? 0 },
    { provider: 'valhalla', role: req.role, mode: req.mode, from: req.from, to: req.to, units: req.units, language: req.language, stationId: req.stationId, bikeKind: req.bikeKind },
  )
}

/** Maps Valhalla HTTP 400 errors: 170/171 on user points → location_unroutable; 154/442 → no_route. */
export function mapValhallaError(err: unknown, req: { fromIsUserPoint?: boolean; toIsUserPoint?: boolean }): unknown {
  if (!(err instanceof AppError) || err.code !== 'http' || err.status !== 400) return err
  const code = isRecord(err.body) ? finiteNumber(err.body.error_code) : undefined
  if ((code === 170 || code === 171) && (req.fromIsUserPoint || req.toIsUserPoint)) {
    return new AppError('location_unroutable', 'Move the pin closer to a street or path.', { status: 400, provider: PROVIDER, body: err.body })
  }
  if (code === 154 || code === 442 || code === 170 || code === 171) return new AppError('no_route', 'No route found.', { status: 400, provider: PROVIDER, body: err.body })
  return err
}
