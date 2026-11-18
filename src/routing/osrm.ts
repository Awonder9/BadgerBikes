// OSRM adapter — route-only outage fallback (never /table). Instruction text is generated in-house.
import { AppError } from '../lib/errors'
import { haversine, isValidLngLat } from '../lib/geo'
import type { LngLat, RouteLeg } from '../types'
import { instructionText, osrmKind } from './maneuvers'
import { badResponse, cleanText, finalizeLeg, finiteNumber, isRecord, type DraftManeuver } from './normalize'
import type { RouteRequest } from './types'

const PROVIDER = 'osrm'
const USER_POINT_MAX_SNAP_M = 500

export function osrmRouteUrl(base: string, req: RouteRequest): string {
  const c = (p: LngLat) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`
  const q = new URLSearchParams({ overview: 'false', steps: 'true', geometries: 'geojson' })
  if (req.fromIsUserPoint || req.toIsUserPoint) q.set('radiuses', `${req.fromIsUserPoint ? 500 : 'unlimited'};${req.toIsUserPoint ? 500 : 'unlimited'}`)
  if (req.headingDeg !== undefined) q.set('bearings', `${Math.round(req.headingDeg)},45;`)
  return `${base}/route/v1/driving/${c(req.from)};${c(req.to)}?${q.toString()}`
}

function coords(v: unknown): LngLat[] {
  if (!isRecord(v) || !Array.isArray(v.coordinates)) return []
  return v.coordinates.filter((p): p is LngLat => isValidLngLat(p))
}

/** OSRM /route JSON → RouteLeg; code !== 'Ok' is an error even on HTTP 200. */
export function normalizeOsrmRoute(json: unknown, req: RouteRequest): RouteLeg {
  if (!isRecord(json)) throw badResponse(PROVIDER, 'not an object')
  if (json.code !== 'Ok') throw osrmCodeError(json.code)
  if (Array.isArray(json.waypoints)) {
    const flags = [req.fromIsUserPoint, req.toIsUserPoint]
    json.waypoints.forEach((w, i) => {
      if (flags[i] && isRecord(w) && (finiteNumber(w.distance) ?? 0) > USER_POINT_MAX_SNAP_M) {
        throw new AppError('location_unroutable', 'Move the pin closer to a street or path.', { provider: PROVIDER })
      }
    })
  }
  const route = Array.isArray(json.routes) ? json.routes[0] : undefined
  const leg = isRecord(route) && Array.isArray(route.legs) ? route.legs[0] : undefined
  if (!isRecord(leg) || !Array.isArray(leg.steps) || leg.steps.length === 0) throw badResponse(PROVIDER, 'no steps')
  const geometry: LngLat[] = []
  const maneuvers: DraftManeuver[] = []
  for (const step of leg.steps) {
    if (!isRecord(step)) continue
    const pts = coords(step.geometry)
    const begin = Math.max(0, geometry.length - 1)
    geometry.push(...(geometry.length === 0 ? pts : pts.slice(1)))
    const man = isRecord(step.maneuver) ? step.maneuver : {}
    const type = typeof man.type === 'string' ? man.type : ''
    const kind = osrmKind(type, typeof man.modifier === 'string' ? man.modifier : undefined)
    const street = cleanText(step.name)
    const exit = finiteNumber(man.exit)
    const m: DraftManeuver = {
      kind,
      instruction: instructionText(kind, { street, exit, isBike: req.mode === 'bike' }),
      distance: finiteNumber(step.distance) ?? 0,
      duration: finiteNumber(step.duration) ?? 0,
      beginIndex: begin,
      endIndex: begin,
    }
    if (street) m.streetNames = [street]
    if (exit !== undefined) m.exitNumber = exit
    maneuvers.push(m)
  }
  const last = Math.max(0, geometry.length - 1)
  const arrive = maneuvers[maneuvers.length - 1]
  if (arrive) {
    // OSRM's arrive step geometry is degenerate; pin it to the final point first.
    arrive.kind = 'arrive'
    arrive.beginIndex = last
    arrive.instruction = instructionText('arrive')
  }
  for (let i = 0; i < maneuvers.length; i++) {
    const m = maneuvers[i]!
    m.beginIndex = Math.min(m.beginIndex, last)
    m.endIndex = i + 1 < maneuvers.length ? Math.min(maneuvers[i + 1]!.beginIndex, last) : last
  }
  if (geometry.length < 2 || haversine(geometry[0]!, geometry[last]!) === 0) throw new AppError('no_route', 'Empty OSRM route', { provider: PROVIDER })
  return finalizeLeg(
    { geometry, maneuvers, distance: finiteNumber(leg.distance) ?? 0, duration: finiteNumber(leg.duration) ?? 0 },
    { provider: 'osrm', role: req.role, mode: req.mode, from: req.from, to: req.to, units: req.units, language: req.language, stationId: req.stationId, bikeKind: req.bikeKind },
  )
}

function osrmCodeError(code: unknown): AppError {
  if (code === 'NoSegment') return new AppError('location_unroutable', 'Move the pin closer to a street or path.', { provider: PROVIDER })
  if (code === 'NoRoute') return new AppError('no_route', 'No route found.', { provider: PROVIDER })
  return new AppError('bad_response', `OSRM error ${String(code)}`, { provider: PROVIDER })
}

/** Maps OSRM HTTP 400 bodies ({ code }) to domain errors. */
export function mapOsrmError(err: unknown): unknown {
  if (err instanceof AppError && err.code === 'http' && err.status === 400 && isRecord(err.body)) return osrmCodeError(err.body.code)
  return err
}
