// Request validation for the Worker API. Everything from the client is untrusted.
import type { RouteApiRequest } from '../src/api/contract'
import { APP, GEOCODE, HTTP } from '../src/config'
import { SYSTEMS } from '../src/data/systems'
import { AppError } from '../src/lib/errors'
import { isValidLngLat } from '../src/lib/geo'
import type { BcycleSystem, LngLat } from '../src/types'

const bad = (msg: string) => new AppError('bad_request', msg)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/

const systemsById = new Map(SYSTEMS.map((s) => [s.id, s]))

export function requireSystem(id: unknown): BcycleSystem {
  const s = typeof id === 'string' ? systemsById.get(id) : undefined
  if (!s) throw new AppError('unknown_system', 'Unknown bike-share system')
  return s
}

export function lngLat(v: unknown, what: string): LngLat {
  if (!isValidLngLat(v)) throw bad(`Invalid ${what} coordinates`)
  return [v[0], v[1]]
}

export function latLonParams(params: URLSearchParams): LngLat {
  const lat = Number(params.get('lat'))
  const lon = Number(params.get('lon'))
  const c: LngLat = [lon, lat]
  if (params.get('lat') === null || params.get('lon') === null || !isValidLngLat(c)) throw bad('lat and lon are required')
  return c
}

const optId = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : undefined)

export function routeRequest(body: unknown): RouteApiRequest {
  if (!isObj(body)) throw bad('Invalid body')
  const role = body.role === 'toPickup' || body.role === 'ride' || body.role === 'toDestination' ? body.role : 'walkOnly'
  const r: RouteApiRequest = {
    systemId: requireSystem(body.systemId).id,
    role,
    mode: body.mode === 'bike' ? 'bike' : 'walk',
    from: lngLat(body.from, 'from'),
    to: lngLat(body.to, 'to'),
    units: body.units === 'metric' ? 'metric' : 'imperial',
    language: APP.language,
    priority: body.priority === 'background' ? 'background' : 'interactive',
  }
  if (typeof body.headingDeg === 'number' && Number.isFinite(body.headingDeg)) r.headingDeg = ((body.headingDeg % 360) + 360) % 360
  const sid = optId(body.stationId)
  if (sid) r.stationId = sid
  if (body.fromIsUserPoint === true) r.fromIsUserPoint = true
  if (body.toIsUserPoint === true) r.toIsUserPoint = true
  if (body.bikeKind === 'electric') r.bikeKind = 'electric'
  return r
}

export function geocodeQuery(raw: string | null): string {
  const q = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, GEOCODE.maxQueryLength)
  if (q.length < GEOCODE.minChars) throw bad(`Query must be at least ${GEOCODE.minChars} characters`)
  return q
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const len = Number(request.headers.get('content-length') ?? '0')
  if (len > HTTP.maxBodyBytes) throw bad('Body too large')
  const text = await request.text()
  if (text.length > HTTP.maxBodyBytes) throw bad('Body too large')
  try {
    return JSON.parse(text)
  } catch {
    throw bad('Body must be JSON')
  }
}
