// Photon geocoding (runs in the Worker): search + reverse, normalized to Place.
import { CACHE_TTL_MS, ENDPOINTS, GEOCODE } from '../config'
import { bboxContains, haversine, isValidLngLat } from '../lib/geo'
import type { UpstreamFetch } from '../lib/upstream'
import type { BBox, LngLat, Place } from '../types'

export interface GeocodeBias {
  /** System medoid (or the user's position when inside the system bbox). */
  center: LngLat
  /** Station bbox; padded by GEOCODE.bboxPadMeters before use as a hard filter. */
  bbox: BBox
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ').slice(0, GEOCODE.maxQueryLength)
}

function padBBox(b: BBox, meters: number): BBox {
  const dLat = meters / 111_320
  const dLon = meters / (111_320 * Math.max(0.01, Math.cos(((b[1] + b[3]) / 2) * (Math.PI / 180))))
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat]
}

interface Feature {
  coord: LngLat
  props: Record<string, unknown>
}

function features(json: unknown): Feature[] {
  if (!isRecord(json) || !Array.isArray(json.features)) return []
  const out: Feature[] = []
  for (const f of json.features) {
    if (!isRecord(f) || !isRecord(f.geometry) || !isRecord(f.properties)) continue
    const c = f.geometry.coordinates
    if (!isValidLngLat(c)) continue
    out.push({ coord: [c[0], c[1]], props: f.properties })
  }
  return out
}

function label(p: Record<string, unknown>): { name: string; detail?: string } | null {
  const street = str(p.street)
  const house = str(p.housenumber)
  const addr = street ? (house ? `${house} ${street}` : street) : undefined
  const city = str(p.city) ?? str(p.locality) ?? str(p.district) ?? str(p.county)
  const n = str(p.name)
  const name = n ?? addr ?? city
  if (!name) return null
  const parts = [n && addr ? addr : undefined, name !== city ? city : undefined].filter((x): x is string => !!x)
  return parts.length ? { name, detail: parts.join(', ') } : { name }
}

/** Photon /api FeatureCollection → de-duplicated Places (same name|street|city within GEOCODE.dedupeMeters), max GEOCODE.keep. */
export function normalizePhotonSearch(json: unknown): Place[] {
  const out: Array<Place & { key: string }> = []
  for (const f of features(json)) {
    const l = label(f.props)
    if (!l) continue
    const key = `${l.name}|${str(f.props.street) ?? ''}|${str(f.props.city) ?? ''}`.toLowerCase()
    if (out.some((p) => p.key === key && haversine(p.coord, f.coord) < GEOCODE.dedupeMeters)) continue
    out.push({ key, kind: 'search', name: l.name, ...(l.detail ? { detail: l.detail } : {}), coord: f.coord })
    if (out.length >= GEOCODE.keep) break
  }
  return out.map(({ key: _key, ...p }) => p)
}

/** Photon /reverse → Place, or null when nothing is near (UI shows "Dropped pin"). */
export function normalizePhotonReverse(json: unknown, coord: LngLat): Place | null {
  const f = features(json)[0]
  if (!f) return null
  const l = label(f.props)
  if (!l) return null
  return { kind: 'mapPick', name: l.name, ...(l.detail ? { detail: l.detail } : {}), coord }
}

export async function searchPlaces(query: string, bias: GeocodeBias, upstream: UpstreamFetch, opts: { signal?: AbortSignal } = {}): Promise<Place[]> {
  const q = normalizeQuery(query)
  if (q.length < GEOCODE.minChars) return []
  const b = padBBox(bias.bbox, GEOCODE.bboxPadMeters)
  const params = new URLSearchParams({
    q,
    lat: bias.center[1].toFixed(5),
    lon: bias.center[0].toFixed(5),
    zoom: String(GEOCODE.zoom),
    location_bias_scale: String(GEOCODE.locationBiasScale),
    bbox: b.map((n) => n.toFixed(5)).join(','),
    limit: String(GEOCODE.limit),
    lang: 'en',
  })
  const json = await upstream<unknown>({
    url: `${ENDPOINTS.photon}/api/?${params.toString()}`,
    group: 'photon',
    priority: 'interactive',
    provider: 'photon',
    signal: opts.signal,
    cacheKey: `photon|search|${q.toLowerCase()}|${params.get('lat')}|${params.get('lon')}|${params.get('bbox')}`,
    cacheTtlMs: CACHE_TTL_MS.geocode,
  })
  return normalizePhotonSearch(json).filter((p) => bboxContains(b, p.coord))
}

export async function reversePlace(coord: LngLat, upstream: UpstreamFetch, opts: { signal?: AbortSignal } = {}): Promise<Place | null> {
  const params = new URLSearchParams({ lat: coord[1].toFixed(5), lon: coord[0].toFixed(5), limit: '1', radius: String(GEOCODE.reverseRadiusKm), lang: 'en' })
  const json = await upstream<unknown>({
    url: `${ENDPOINTS.photon}/reverse?${params.toString()}`,
    group: 'photon',
    priority: 'interactive',
    provider: 'photon',
    signal: opts.signal,
    cacheKey: `photon|reverse|${params.get('lat')}|${params.get('lon')}`,
    cacheTtlMs: CACHE_TTL_MS.geocode,
  })
  return normalizePhotonReverse(json, coord)
}
