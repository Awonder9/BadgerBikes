// Request validation for the Worker API. Everything from the client is untrusted.
import type { PushRideRequest, PushSubscriptionJson, RouteApiRequest, UsageFirst, UsagePlatform, UsageRequest } from '../src/api/contract'
import { APP, GEOCODE, HTTP, PUSH, ROUTE_DETAILS, USAGE } from '../src/config'
import { SYSTEMS } from '../src/data/systems'
import { LANGS, type Lang } from '../src/i18n/lang'
import { base64urlToBytes } from '../src/lib/base64url'
import { AppError } from '../src/lib/errors'
import { isValidLngLat } from '../src/lib/geo'
import { decodePolyline } from '../src/lib/polyline'
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

/** Route geometry as an encoded polyline6: printable polyline characters only, bounded size. */
export function routeDetailsRequest(body: unknown): { systemId: string; polyline: string } {
  if (!isObj(body)) throw bad('Invalid body')
  const polyline = typeof body.polyline === 'string' ? body.polyline : ''
  if (polyline.length < 4 || polyline.length > ROUTE_DETAILS.maxPolylineChars || !/^[\x3f-\x7e]+$/.test(polyline)) throw bad('Invalid polyline')
  let coords: LngLat[]
  try {
    coords = decodePolyline(polyline, 6)
  } catch {
    throw bad('Invalid polyline')
  }
  if (coords.length < 2 || coords.length > ROUTE_DETAILS.maxPoints || !coords.every(isValidLngLat)) throw bad('Invalid polyline')
  return { systemId: requireSystem(body.systemId).id, polyline }
}

export function geocodeQuery(raw: string | null): string {
  const q = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, GEOCODE.maxQueryLength)
  if (q.length < GEOCODE.minChars) throw bad(`Query must be at least ${GEOCODE.minChars} characters`)
  return q
}

/**
 * A push endpoint the Worker may send to: https on a known push service (PUSH.endpointHosts) — never an
 * arbitrary URL, so a subscription can't turn the Worker into a request relay.
 */
export function pushEndpoint(v: unknown): string {
  if (typeof v !== 'string' || v.length > PUSH.maxEndpointLength) throw bad('Invalid push endpoint')
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw bad('Invalid push endpoint')
  }
  const host = url.hostname.toLowerCase()
  const known = PUSH.endpointHosts.some((h) => host === h || host.endsWith(`.${h}`))
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !known) throw bad('Unsupported push service')
  return url.href
}

function pushSubscription(v: unknown): PushSubscriptionJson {
  if (!isObj(v) || !isObj(v.keys)) throw bad('Invalid push subscription')
  const { p256dh, auth } = v.keys
  const key = typeof p256dh === 'string' ? base64urlToBytes(p256dh) : null
  const secret = typeof auth === 'string' ? base64urlToBytes(auth) : null
  if (!key || key.length !== 65 || key[0] !== 4 || !secret || secret.length !== 16) throw bad('Invalid push subscription keys')
  return { endpoint: pushEndpoint(v.endpoint), keys: { p256dh: p256dh as string, auth: auth as string } }
}

/** An integer in [min, max], or null when `v` is null; anything else is a bad request. */
function intOrNull(v: unknown, min: number, max: number, what: string): number | null {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`Invalid ${what}`)
  return v
}

/** POST /api/push/ride body. Times must be plausible for a ride under way now. */
export function pushRideRequest(body: unknown, nowMs: number): PushRideRequest {
  if (!isObj(body)) throw bad('Invalid body')
  const lang: Lang | undefined = LANGS.find((l) => l === body.lang)
  if (!lang) throw bad('Invalid language')
  const partySize = intOrNull(body.partySize, 1, 4, 'party size')
  if (partySize === null) throw bad('Invalid party size')
  const end = body.endStationId
  const endStationId = end === null ? null : optId(end)
  if (endStationId === undefined) throw bad('Invalid end dock')
  return {
    subscription: pushSubscription(body.subscription),
    lang,
    systemId: requireSystem(body.systemId).id,
    endStationId,
    partySize,
    rideStartedAtMs: intOrNull(body.rideStartedAtMs, nowMs - PUSH.maxRideMs, nowMs + 60_000, 'ride start'),
    includedMinutes: intOrNull(body.includedMinutes, 1, 600, 'included minutes'),
  }
}

/** POST /api/push/cancel body. */
export function pushCancelRequest(body: unknown): { endpoint: string } {
  if (!isObj(body)) throw bad('Invalid body')
  return { endpoint: pushEndpoint(body.endpoint) }
}

const PLATFORMS: readonly UsagePlatform[] = ['ios', 'android', 'desktop']

function usageFirst(v: unknown): UsageFirst {
  if (!isObj(v)) throw bad('Invalid usage report')
  const gap = v.gap === null ? null : intOrNull(v.gap ?? NaN, 1, USAGE.maxGapDays, 'gap')
  const platform = PLATFORMS.find((p) => p === v.platform)
  const lang = LANGS.find((l) => l === v.lang)
  if (!platform || !lang || typeof v.installed !== 'boolean') throw bad('Invalid usage report')
  // A city this Worker doesn't know (an older or newer app) still counts the device, without the city.
  const systemId = typeof v.systemId === 'string' && systemsById.has(v.systemId) ? v.systemId : null
  return { gap, systemId, platform, installed: v.installed, lang }
}

/** POST /api/usage body: only the known kinds, events and fields (see UsageRequest). */
export function usageRequest(body: unknown): UsageRequest {
  if (!isObj(body)) throw bad('Invalid body')
  if (body.kind === 'event') {
    const name = USAGE.events.find((e) => e === body.name)
    if (!name) throw bad('Unknown event')
    return { kind: 'event', name }
  }
  if (body.kind !== 'open' && body.kind !== 'beat') throw bad('Invalid kind')
  return { kind: body.kind, first: body.first === null || body.first === undefined ? null : usageFirst(body.first) }
}

/** ?days= for the dashboard: an integer in [1, USAGE.maxReportDays] (default 90). */
export function reportDays(raw: string | null): number {
  if (raw === null) return 90
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > USAGE.maxReportDays) throw bad('Invalid days')
  return n
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
