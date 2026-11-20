// GBFS access for BCycle systems (runs in the Worker): pure normalizers + thin fetchers over an injected
// UpstreamFetch. Feed JSON is untrusted: every field is narrowed from `unknown`, never cast.
//
// BCycle facts that shape this module (docs/ARCHITECTURE.md §3): feeds are GBFS 1.1 (booleans 0/1) or 2.1
// (true/false); timestamps are epoch seconds; `num_bikes_available_types` carries the classic/e-bike split;
// names may have trailing spaces; pricing URLs often lack a scheme; seasonal systems list 0 stations.
import { CACHE_TTL_MS, ENDPOINTS, RIDE } from '../config'
import { AppError, isAbort, isAppError } from '../lib/errors'
import { isValidLngLat } from '../lib/geo'
import type { UpstreamFetch } from '../lib/upstream'
import type { AppLink, LngLat, PassOption, Station, StationInfo, StationStatus, StationsSnapshot, SystemDetails } from '../types'

export type GbfsFeed = 'station_information' | 'station_status' | 'system_information' | 'system_pricing_plans'

/**
 * Parsed included ride times outside [1, MAX_INCLUDED_MINUTES] are ignored: they come from text such as
 * "charges may take up to 48 hours" or "24-hour pass", not from a per-ride allowance.
 */
export const MAX_INCLUDED_MINUTES = RIDE.maxIncludedMinutes

const PROVIDER = 'gbfs'
/** BCycle extension field: 'Kiosk and Station' or '3.0 Dock Station' (kiosk-less, app-only rental). */
const STATION_TYPE_FIELD = '_bcycle_station_type'
const APP_STORE_HOSTS: ReadonlySet<string> = new Set(['apps.apple.com', 'itunes.apple.com', 'play.google.com'])
/** Schemes that must never be offered as an "open the app" link. */
const UNSAFE_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'http', 'ftp', 'ws', 'wss'])

// ─── Narrowing helpers ───────────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>

const isRecord = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** GBFS 1.1 uses 0/1, 2.1 uses true/false. Anything else (including "1") is false. */
const toBool = (v: unknown): boolean => v === true || v === 1

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Trimmed non-empty string, or null. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Identifier fields: non-empty strings (trimmed) or finite numbers. */
function idOf(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  return text(v)
}

/** Finite number from a number or a numeric string, else NaN. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return Number.NaN
}

/** Counts are non-negative integers; garbage becomes 0. */
function count(v: unknown): number {
  const n = num(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/** GBFS epoch seconds → epoch ms. Values that are already ms (> 1e11, i.e. after year 5138 in seconds) pass through. */
function epochMs(v: unknown): number | null {
  const n = num(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n > 1e11 ? n : n * 1000)
}

/** `json.data[key]` as an array, or a bad_response error naming the feed. */
function dataArray(json: unknown, key: string, feed: GbfsFeed): unknown[] {
  const data = isRecord(json) ? json.data : undefined
  const list = isRecord(data) ? data[key] : undefined
  if (!Array.isArray(list)) throw new AppError('bad_response', `GBFS ${feed} has no data.${key} array`, { provider: PROVIDER })
  return list
}

function coordOf(lon: unknown, lat: unknown): LngLat | null {
  const coord: LngLat = [num(lon), num(lat)]
  if (!isValidLngLat(coord)) return null
  // (0, 0) is a placeholder for "not placed yet", never a real BCycle station.
  if (coord[0] === 0 && coord[1] === 0) return null
  return coord
}

// ─── URLs ────────────────────────────────────────────────────────────────────────────────────────

/** `${ENDPOINTS.gbfsBase}/${systemId}/${feed}.json` — no runtime discovery (BCycle's gbfs.json lists absolute URLs). */
export function gbfsFeedUrl(systemId: string, feed: GbfsFeed): string {
  return `${ENDPOINTS.gbfsBase}/${encodeURIComponent(systemId)}/${feed}.json`
}

/**
 * Normalizes a feed URL to https: adds the missing scheme ("madison.bcycle.com"), upgrades http, and
 * rejects other schemes, credentials, whitespace and dot-less hosts. Returns the URL's href or null.
 */
export function normalizeHttpsUrl(raw: unknown): string | null {
  const s = text(raw)
  if (s === null || /\s/.test(s)) return null
  let candidate: string
  if (s.startsWith('//')) candidate = `https:${s}`
  else if (/^[a-z][a-z\d+.-]*:/i.test(s)) candidate = s.replace(/^http:/i, 'https:')
  else candidate = `https://${s}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.hostname.includes('.')) return null
  return url.href
}

/** rental_apps.{ios,android} → AppLink when both the app scheme and the store link are safe. */
function appLink(raw: unknown): AppLink | null {
  if (!isRecord(raw)) return null
  const discovery = text(raw.discovery_uri)
  const scheme = discovery ? /^([a-z][a-z\d+.-]*):\/\/\S*$/i.exec(discovery)?.[1]?.toLowerCase() : undefined
  const storeUri = normalizeHttpsUrl(raw.store_uri)
  if (!discovery || !scheme || UNSAFE_SCHEMES.has(scheme) || !storeUri) return null
  if (!APP_STORE_HOSTS.has(new URL(storeUri).hostname)) return null
  return { discoveryUri: discovery, storeUri }
}

// ─── Stations ────────────────────────────────────────────────────────────────────────────────────

function parseStationInfo(raw: unknown): StationInfo | null {
  if (!isRecord(raw)) return null
  const id = idOf(raw.station_id)
  const coord = coordOf(raw.lon, raw.lat)
  if (id === null || coord === null) return null
  return {
    id,
    name: text(raw.name) ?? id,
    address: text(raw.address),
    coord,
    hasKiosk: raw[STATION_TYPE_FIELD] === 'Kiosk and Station',
  }
}

/**
 * station_information → StationInfo[] in feed order: trimmed names, [lon, lat], hasKiosk (region_id and
 * rental_uris are not used). Stations without an id or with invalid/(0,0) coordinates are dropped;
 * a repeated station id keeps its first occurrence. Throws AppError('bad_response') if the feed has no
 * station list.
 */
export function normalizeStationInformation(json: unknown): StationInfo[] {
  const out: StationInfo[] = []
  const seen = new Set<string>()
  for (const raw of dataArray(json, 'stations', 'station_information')) {
    const info = parseStationInfo(raw)
    if (info === null || seen.has(info.id)) continue
    seen.add(info.id)
    out.push(info)
  }
  return out
}

function parseStationStatus(raw: JsonObject): StationStatus {
  // smart is always 0 on BCycle and is ignored; no breakdown at all → null (the UI then shows only totals).
  const types = isRecord(raw.num_bikes_available_types) ? raw.num_bikes_available_types : null
  return {
    bikes: count(raw.num_bikes_available),
    docks: count(raw.num_docks_available),
    ebikes: types ? count(types.electric) : null,
    classic: types ? count(types.classic) : null,
    isInstalled: toBool(raw.is_installed),
    isRenting: toBool(raw.is_renting),
    isReturning: toBool(raw.is_returning),
  }
}

/**
 * station_status (GBFS 1.1 0/1 or 2.1 booleans) → statuses by station id + feed time in epoch ms.
 * Throws AppError('bad_response') when the feed has no station list or no valid last_updated.
 */
export function normalizeStationStatus(json: unknown): { lastUpdatedMs: number; statuses: Map<string, StationStatus> } {
  const stations = dataArray(json, 'stations', 'station_status')
  const lastUpdatedMs = isRecord(json) ? epochMs(json.last_updated) : null
  if (lastUpdatedMs === null) throw new AppError('bad_response', 'GBFS station_status has no valid last_updated', { provider: PROVIDER })
  const statuses = new Map<string, StationStatus>()
  for (const raw of stations) {
    if (!isRecord(raw)) continue
    const id = idOf(raw.station_id)
    if (id === null || statuses.has(id)) continue
    statuses.set(id, parseStationStatus(raw))
  }
  return { lastUpdatedMs, statuses }
}

/** Joins info and status by station id, in station_information order; status is null when missing. */
export function mergeStations(info: readonly StationInfo[], statuses: ReadonlyMap<string, StationStatus>): Station[] {
  return info.map((s) => ({ ...s, status: statuses.get(s.id) ?? null }))
}

export function buildSnapshot(systemId: string, stations: Station[], lastUpdatedMs: number, fetchedAtMs: number): StationsSnapshot {
  return { systemId, stations, byId: new Map(stations.map((s) => [s.id, s])), lastUpdatedMs, fetchedAtMs }
}

/**
 * Cache TTL for a station_status body: until just after its CDN copy expires (last_updated + 62 s),
 * clamped to [CACHE_TTL_MS.stationStatusMin, CACHE_TTL_MS.stationStatusMax]. An unreadable body gets the minimum.
 */
export function stationStatusTtlMs(body: unknown, nowMs: number): number {
  const lastUpdatedMs = isRecord(body) ? epochMs(body.last_updated) : null
  if (lastUpdatedMs === null) return CACHE_TTL_MS.stationStatusMin
  return clamp(lastUpdatedMs + CACHE_TTL_MS.stationStatusAfterFeedMs - nowMs, CACHE_TTL_MS.stationStatusMin, CACHE_TTL_MS.stationStatusMax)
}

// ─── Pricing ─────────────────────────────────────────────────────────────────────────────────────

/** "60 minutes", "30-min", "90min", "2-hour", "1hr", "1.5 hours" (not the tail of a decimal such as "$7.63"). */
const DURATION_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*-?\s*(min(?:ute)?s?|hours?|hrs?)\b/gi
/** A duration right after one of these is a billing period ("$4 per 30 minutes", "$5/30 minutes", "every 60 minutes"). */
const RATE_PREFIX_RE = /(?:\bper|\/|\bevery|\badditional)\s*$/i

interface DurationMention {
  minutes: number
  unit: 'min' | 'hour'
  isRate: boolean
}

function durationMentions(s: string): DurationMention[] {
  const out: DurationMention[] = []
  for (const m of s.matchAll(DURATION_RE)) {
    const value = Number(m[1])
    const unit = (m[2] ?? '').toLowerCase().startsWith('min') ? 'min' : 'hour'
    const minutes = Math.round(unit === 'min' ? value : value * 60)
    if (!(minutes >= 1 && minutes <= MAX_INCLUDED_MINUTES)) continue
    const before = s.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0)
    out.push({ minutes, unit, isRate: RATE_PREFIX_RE.test(before) })
  }
  return out
}

/** Preference: a minutes mention, then an hours mention, then the same among billing periods. */
function pickIncluded(mentions: readonly DurationMention[]): number | null {
  for (const isRate of [false, true]) {
    for (const unit of ['min', 'hour'] as const) {
      const hit = mentions.find((m) => m.isRate === isRate && m.unit === unit)
      if (hit) return hit.minutes
    }
  }
  return null
}

/**
 * Minutes included per ride, parsed from a plan's description (then its name), or null for pay-per-minute
 * and unknown plans. Follows docs/ARCHITECTURE.md §5 (first "N min", else "N hour" × 60, else the name),
 * refined with evidence from all live BCycle pricing feeds: billing periods ("$7.63 / 30 minutes for rides
 * over 60 minutes", "$9.30 per 30 mins") rank below other mentions, "hr" counts as an hour, and values
 * outside 1–MAX_INCLUDED_MINUTES are ignored ("up to 48 hours after returning").
 *
 * "60 minutes per ride" → 60; "$5 per 15 minutes" → 15; "2-hour trips" → 120; "$1 + $0.45/minute" → null.
 */
export function parseIncludedMinutes(name: string, description: string): number | null {
  for (const s of [description, name]) {
    const minutes = pickIncluded(durationMentions(s))
    if (minutes !== null) return minutes
  }
  return null
}

function parsePass(raw: unknown): PassOption | null {
  if (!isRecord(raw)) return null
  const id = idOf(raw.plan_id)
  const price = num(raw.price)
  if (id === null || !Number.isFinite(price) || price < 0) return null
  const name = text(raw.name) ?? id
  const description = text(raw.description) ?? ''
  const currency = text(raw.currency)?.toUpperCase()
  return {
    id,
    name,
    price,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : 'USD',
    description,
    includedMinutes: parseIncludedMinutes(name, description),
    url: normalizeHttpsUrl(raw.url),
  }
}

function normalizePasses(pricingPlans: unknown): PassOption[] {
  const data = isRecord(pricingPlans) ? pricingPlans.data : undefined
  const plans = isRecord(data) ? data.plans : undefined
  if (!Array.isArray(plans)) return []
  return plans.flatMap((p) => parsePass(p) ?? [])
}

const TIMEZONE_RE = /^[A-Za-z][A-Za-z\d_+-]*(?:\/[A-Za-z\d_+-]+)*$/
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/

/**
 * system_information + system_pricing_plans → SystemDetails. `pricingPlans` may be null or malformed
 * (→ no passes). Throws AppError('bad_response') if system_information has no `data` object.
 */
export function normalizeSystemDetails(systemId: string, systemInformation: unknown, pricingPlans: unknown): SystemDetails {
  const data = isRecord(systemInformation) ? systemInformation.data : undefined
  if (!isRecord(data)) throw new AppError('bad_response', 'GBFS system_information has no data object', { provider: PROVIDER })
  const apps = isRecord(data.rental_apps) ? data.rental_apps : {}
  const timezone = text(data.timezone)
  const email = text(data.email)
  const passes = normalizePasses(pricingPlans)
  const included = passes.flatMap((p) => (p.includedMinutes === null ? [] : [p.includedMinutes]))
  return {
    systemId,
    name: text(data.name) ?? systemId,
    timezone: timezone && TIMEZONE_RE.test(timezone) ? timezone : 'UTC',
    phone: text(data.phone_number),
    email: email && EMAIL_RE.test(email) ? email : null,
    websiteUrl: normalizeHttpsUrl(data.url),
    rentalApps: { ios: appLink(apps.ios), android: appLink(apps.android) },
    passes,
    defaultIncludedMinutes: included.length > 0 ? Math.min(...included) : null,
  }
}

// ─── Fetchers ────────────────────────────────────────────────────────────────────────────────────

/** One GBFS feed through the upstream layer (no rate gate: the feeds are CDN-backed). 404 → not_found. */
async function fetchFeed(upstream: UpstreamFetch, systemId: string, feed: GbfsFeed, cacheTtlMs: number | ((body: unknown) => number), signal: AbortSignal | undefined): Promise<unknown> {
  try {
    return await upstream<unknown>({
      url: gbfsFeedUrl(systemId, feed),
      group: null,
      priority: 'interactive',
      provider: PROVIDER,
      signal,
      cacheKey: `gbfs:${systemId}:${feed}`,
      cacheTtlMs,
    })
  } catch (err) {
    if (isAppError(err, 'http') && err.status === 404) {
      throw new AppError('not_found', `No GBFS ${feed} feed for ${systemId}`, { status: 404, provider: PROVIDER, body: err.body, cause: err })
    }
    throw err
  }
}

/**
 * Fetches station_information (cached CACHE_TTL_MS.stationInformation) and station_status (cached until
 * its CDN expiry) in parallel and merges them. Rejects with AppError: 'not_found' (feed 404), 'bad_response',
 * or the upstream's transport error.
 */
export async function fetchStationsSnapshot(systemId: string, upstream: UpstreamFetch, opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<StationsSnapshot> {
  const now = opts.now ?? (() => Date.now())
  const [infoJson, statusJson] = await Promise.all([
    fetchFeed(upstream, systemId, 'station_information', CACHE_TTL_MS.stationInformation, opts.signal),
    fetchFeed(upstream, systemId, 'station_status', (body) => stationStatusTtlMs(body, now()), opts.signal),
  ])
  const info = normalizeStationInformation(infoJson)
  const { lastUpdatedMs, statuses } = normalizeStationStatus(statusJson)
  return buildSnapshot(systemId, mergeStations(info, statuses), lastUpdatedMs, now())
}

/**
 * Fetches system_information + system_pricing_plans (both cached CACHE_TTL_MS.systemInformation). A pricing
 * failure (other than an abort) degrades to no passes; a system_information failure rejects.
 */
export async function fetchSystemDetails(systemId: string, upstream: UpstreamFetch, opts: { signal?: AbortSignal } = {}): Promise<SystemDetails> {
  const [info, pricing] = await Promise.all([
    fetchFeed(upstream, systemId, 'system_information', CACHE_TTL_MS.systemInformation, opts.signal),
    fetchFeed(upstream, systemId, 'system_pricing_plans', CACHE_TTL_MS.systemInformation, opts.signal).catch((err: unknown) => {
      if (isAbort(err)) throw err
      return null
    }),
  ])
  return normalizeSystemDetails(systemId, info, pricing)
}
