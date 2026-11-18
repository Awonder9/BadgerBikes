#!/usr/bin/env node
// Regenerates src/data/systems.json — the registry of BCycle systems the app offers (BcycleSystem in
// src/types.ts).
//
// Source of truth: MobilityData's GBFS systems catalog (rows whose feeds live on gbfs.bcycle.com). Every
// system is probed at the same feed URLs the app uses (`${GBFS_BASE}/${id}/${feed}.json`):
//   • any feed answering other than HTTP 200 → the system is dropped (e.g. retired systems that 404);
//   • stations → bbox of the stations and `center` = station medoid (a real station, never the bbox middle);
//   • 0 stations (seasonal systems in winter) → `active: false`, keeping the previously committed
//     bbox/center, or — for a system never seen with stations — a ±5 km box around the catalog "Location"
//     geocoded once through Photon.
// Network failures abort the run without writing, and the run fails if any bbox/center is not finite.
//
// Usage: npm run update-systems
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const CATALOG_URL = 'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv'
export const GBFS_BASE = 'https://gbfs.bcycle.com'
export const PHOTON_URL = 'https://photon.komoot.io'
/**
 * The app's User-Agent (APP.userAgent in src/config.ts, which Node cannot import because it reads
 * import.meta.env); scripts/update-systems.test.mjs keeps the two equal.
 */
export const USER_AGENT = 'badger-bikes/0.1 (+https://github.com/Awonder9/BadgerBikes)'
/** Half-size of the box around a geocoded city for a system that has never listed a station. */
export const GEOCODED_BBOX_HALF_KM = 5
/** Feeds the app reads at runtime; all must answer HTTP 200 (plus the catalog's auto-discovery URL). */
export const REQUIRED_FEEDS = ['system_information', 'station_information', 'station_status']

const OUT = fileURLToPath(new URL('../src/data/systems.json', import.meta.url))
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
const TIMEOUT_MS = 20_000
const CONCURRENCY = 4
/** Photon fair use: one geocode at a time, spaced out. */
const GEOCODE_SPACING_MS = 1_100
const EARTH_RADIUS_M = 6_371_008.8

// ─── Pure helpers (exported for tests) ─────────────────────────────────────────────────────────

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF) → one object per row keyed by header. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  const [header, ...body] = rows
  if (!header) return []
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

export const round5 = (n) => Math.round(n * 1e5) / 1e5

const toRad = (deg) => (deg * Math.PI) / 180

/** Great-circle distance in meters between [lon, lat] points. */
export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** station_information JSON → [lon, lat] of stations with valid, non-(0, 0) coordinates. */
export function stationCoords(stationInformation) {
  const stations = stationInformation?.data?.stations
  if (!Array.isArray(stations)) throw new Error('station_information has no data.stations array')
  return stations.flatMap((s) => {
    const lon = s?.lon
    const lat = s?.lat
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return []
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90 || (lon === 0 && lat === 0)) return []
    return [[lon, lat]]
  })
}

/** [west, south, east, north] of the points, rounded to 5 dp (null when empty). */
export function bboxOf(points) {
  if (points.length === 0) return null
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lon, lat] of points) {
    w = Math.min(w, lon)
    s = Math.min(s, lat)
    e = Math.max(e, lon)
    n = Math.max(n, lat)
  }
  return [round5(w), round5(s), round5(e), round5(n)]
}

/**
 * The medoid: the point with the smallest total distance to all others (first one on ties), rounded to
 * 5 dp. Unlike a mean or bbox midpoint it is always a real station, even for multi-cluster systems.
 */
export function medoid(points) {
  let best = null
  let bestSum = Infinity
  for (const p of points) {
    let sum = 0
    for (const q of points) sum += haversine(p, q)
    if (sum < bestSum) {
      bestSum = sum
      best = p
    }
  }
  return best && [round5(best[0]), round5(best[1])]
}

/** Box extending `halfKm` from `center` in every direction, rounded to 5 dp. */
export function bboxAround(center, halfKm) {
  const [lon, lat] = center
  const dLat = (halfKm * 1000) / ((EARTH_RADIUS_M * Math.PI) / 180)
  const dLon = dLat / Math.max(0.01, Math.cos(toRad(lat)))
  return [round5(lon - dLon), round5(lat - dLat), round5(lon + dLon), round5(lat + dLat)]
}

/** System id from an auto-discovery URL on the BCycle GBFS host ("https://gbfs.bcycle.com/<id>/gbfs.json"). */
export function systemIdFromUrl(autoDiscoveryUrl) {
  try {
    const url = new URL(autoDiscoveryUrl)
    if (url.hostname !== new URL(GBFS_BASE).hostname) return null
    const m = /^\/([A-Za-z0-9_-]+)\/gbfs\.json$/.exec(url.pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export const isBcycleRow = (row) => systemIdFromUrl(row['Auto-Discovery URL'] ?? '') !== null

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** https URL: adds a missing scheme, upgrades http, rejects anything else (mirrors normalizeHttpsUrl in src/data/gbfs.ts). */
export function httpsUrl(raw) {
  const s = text(raw)
  if (s === null || /\s/.test(s)) return null
  const candidate = s.startsWith('//') ? `https:${s}` : /^[a-z][a-z\d+.-]*:/i.test(s) ? s.replace(/^http:/i, 'https:') : `https://${s}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

const isFinitePoint = (p) => Array.isArray(p) && p.length === 2 && p.every(isFiniteNumber)
const isFiniteBox = (b) => Array.isArray(b) && b.length === 4 && b.every(isFiniteNumber)

/**
 * Builds one registry entry from a catalog row and the system's feeds (all HTTP 200).
 * `previous` is the committed entry (if any); `geocoded` the catalog Location's [lon, lat] (only needed
 * when the system lists no stations and has no previous location). Returns { system } or { dropped }.
 */
export function buildEntry({ row, systemInformation, stationInformation, previous, geocoded }) {
  const id = row['System ID']
  const info = systemInformation?.data ?? {}
  const points = stationCoords(stationInformation)
  let bbox
  let center
  if (points.length > 0) {
    bbox = bboxOf(points)
    center = medoid(points)
  } else if (previous && isFiniteBox(previous.bbox) && isFinitePoint(previous.center)) {
    bbox = previous.bbox
    center = previous.center
  } else if (isFinitePoint(geocoded)) {
    bbox = bboxAround(geocoded, GEOCODED_BBOX_HALF_KM)
    center = [round5(geocoded[0]), round5(geocoded[1])]
  } else {
    return { dropped: `no stations, no previous entry and "${row.Location}" could not be geocoded` }
  }
  return {
    system: {
      id,
      name: text(info.name) ?? text(row.Name) ?? id,
      city: text(row.Location) ?? '',
      url: httpsUrl(info.url) ?? httpsUrl(row.URL) ?? '',
      timezone: text(info.timezone) ?? previous?.timezone ?? 'UTC',
      bbox,
      center,
      stationCount: points.length,
      active: points.length > 0,
      gbfsUrl: row['Auto-Discovery URL'],
    },
  }
}

/** Problems that must fail the run (the client calls fitBounds/flyTo with these values). */
export function validateRegistry(systems) {
  const errors = []
  const seen = new Set()
  for (const s of systems) {
    const where = s?.id ?? '<no id>'
    if (typeof s?.id !== 'string' || s.id === '') errors.push(`${where}: missing id`)
    else if (seen.has(s.id)) errors.push(`${where}: duplicate id`)
    seen.add(s?.id)
    if (!isFiniteBox(s?.bbox)) errors.push(`${where}: bbox is not 4 finite numbers: ${JSON.stringify(s?.bbox)}`)
    else {
      const [w, so, e, n] = s.bbox
      if (w > e || so > n) errors.push(`${where}: bbox is inverted: ${JSON.stringify(s.bbox)}`)
      if (w < -180 || e > 180 || so < -90 || n > 90) errors.push(`${where}: bbox out of range: ${JSON.stringify(s.bbox)}`)
    }
    if (!isFinitePoint(s?.center)) errors.push(`${where}: center is not 2 finite numbers: ${JSON.stringify(s?.center)}`)
    else if (isFiniteBox(s?.bbox)) {
      const [lon, lat] = s.center
      const [w, so, e, n] = s.bbox
      if (lon < w || lon > e || lat < so || lat > n) errors.push(`${where}: center lies outside its bbox`)
    }
    if (!Number.isInteger(s?.stationCount) || s.stationCount < 0) errors.push(`${where}: invalid stationCount`)
    if (s?.active !== (s?.stationCount > 0)) errors.push(`${where}: active must be stationCount > 0`)
  }
  return errors
}

// ─── IO ──────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * GET JSON → { status, body } (body parsed only for HTTP 200). Network errors, timeouts and invalid JSON
 * are retried once, then thrown: the run must not silently drop a system because of a transient failure.
 */
export async function getJson(url, { fetchImpl = globalThis.fetch, retries = 1, retryDelayMs = 1_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.status !== 200) {
        await res.body?.cancel()
        return { status: res.status, body: null }
      }
      return { status: 200, body: await res.json() }
    } catch (err) {
      if (attempt >= retries) throw new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      await sleep(retryDelayMs)
    }
  }
}

/** Photon geocoder for catalog locations ("Truckee, CA" → [lon, lat] | null); calls are serialized and spaced. */
export function createGeocoder({ fetchJson = getJson, spacingMs = GEOCODE_SPACING_MS } = {}) {
  let chain = Promise.resolve()
  let last = -Infinity
  return (location) => {
    const run = async () => {
      const wait = last + spacingMs - Date.now()
      if (wait > 0) await sleep(wait)
      last = Date.now()
      const q = new URLSearchParams({ q: location, limit: '1', lang: 'en' })
      const { status, body } = await fetchJson(`${PHOTON_URL}/api/?${q}`)
      const coords = status === 200 ? body?.features?.[0]?.geometry?.coordinates : null
      return isFinitePoint(coords) ? [coords[0], coords[1]] : null
    }
    const result = chain.then(run, run)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * Probes one catalog row: drops the system unless every required feed answers HTTP 200, then builds its
 * entry (geocoding the catalog Location only when there are no stations and no previous entry).
 */
export async function probeSystem(row, previous, { fetchJson = getJson, geocode } = {}) {
  const id = row['System ID']
  const discoveryUrl = row['Auto-Discovery URL']
  if (systemIdFromUrl(discoveryUrl) !== id) return { id, dropped: `System ID does not match ${discoveryUrl}` }
  const urls = [['gbfs', discoveryUrl], ...REQUIRED_FEEDS.map((feed) => [feed, `${GBFS_BASE}/${id}/${feed}.json`])]
  const bodies = {}
  for (const [feed, url] of urls) {
    const { status, body } = await fetchJson(url)
    if (status !== 200) return { id, dropped: `HTTP ${status} for ${feed}` }
    bodies[feed] = body
  }
  let geocoded = null
  const needsGeocode = stationCoords(bodies.station_information).length === 0 && !(previous && isFiniteBox(previous.bbox) && isFinitePoint(previous.center))
  if (needsGeocode && geocode && row.Location) geocoded = await geocode(row.Location)
  const entry = buildEntry({ row, systemInformation: bodies.system_information, stationInformation: bodies.station_information, previous, geocoded })
  return { id, ...entry }
}

/** Maps `items` with at most `limit` concurrent calls, preserving order. */
export async function mapPool(items, limit, fn) {
  const out = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function readPrevious() {
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'))
    return new Map(prev.map((s) => [s.id, s]))
  } catch {
    return new Map()
  }
}

async function main() {
  const previousById = await readPrevious()
  const res = await fetch(CATALOG_URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${CATALOG_URL}`)
  const rows = parseCsv(await res.text()).filter(isBcycleRow)
  if (rows.length === 0) throw new Error('The catalog lists no BCycle systems; refusing to write an empty registry')

  const geocode = createGeocoder()
  const results = await mapPool(rows, CONCURRENCY, (row) => probeSystem(row, previousById.get(row['System ID']), { geocode }))
  for (const r of results) {
    if (r.dropped) console.warn(`drop ${r.id}: ${r.dropped}`)
    else if (!r.system.active) console.warn(`inactive ${r.id}: 0 stations (bbox/center from ${previousById.has(r.id) ? 'the previous registry' : 'geocoding'})`)
  }
  const systems = results.flatMap((r) => (r.system ? [r.system] : [])).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const errors = validateRegistry(systems)
  if (errors.length > 0) {
    for (const e of errors) console.error(`invalid ${e}`)
    throw new Error(`${errors.length} invalid registry entr${errors.length === 1 ? 'y' : 'ies'}; ${OUT} was not written`)
  }
  await writeFile(OUT, JSON.stringify(systems, null, 2) + '\n')
  console.log(`wrote ${systems.length} systems (${systems.filter((s) => s.active).length} active) to ${OUT}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
