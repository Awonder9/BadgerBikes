#!/usr/bin/env node
// Regenerates src/data/scenic/<system id>.json — each BCycle city's bike trails and scenic places, the raw material
// of "Just ride" loops (src/routing/loop.ts; the format is ScenicData in src/routing/scenic.ts).
//
// Source: OpenStreetMap through the public Overpass API (ODbL; attribution "© OpenStreetMap contributors", already
// shown on the map). One query per city, one at a time and spaced out, as the public instance asks — the app never
// queries Overpass itself, so riders cause no load there. Trails (cycleways, and paths/footways/tracks open to
// bikes) are sampled into candidate waypoints every SAMPLE_EVERY_M; each scores 1, plus extra points for being
// named, by water, in a park or beach, or near a viewpoint. Each point also names the best feature near it, which
// the planner lists as a ride's highlights.
//
// Usage: npm run update-scenic [-- <system id> …]   (default: every active system in src/data/systems.json)
//        OVERPASS_URL=… (another public instance), OVERPASS_TIMEOUT_S=120 (a big city) also work.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter'
/** The app's User-Agent (APP.userAgent in src/config.ts); scripts/update-scenic.test.mjs keeps the two equal. */
export const USER_AGENT = 'badger-bikes/1.0 (+https://github.com/Awonder9/BadgerBikes)'
/** Mirrors SCENIC in src/config.ts (Node cannot import it); the test keeps them equal. */
export const SCENIC = {
  bboxPadMeters: 4_000,
  queryTimeoutSeconds: 25,
  sampleEveryMeters: 350,
  maxPoints: 4_000,
  waterMeters: 150,
  viewpointMeters: 300,
  score: { water: 2, park: 2, viewpoint: 3, namedRoute: 1 },
}
/** Trail ways shorter than this get no point (crossings, ramps, stubs). */
export const MIN_WAY_METERS = 120
/** A point-shaped park (a node) counts within this radius. */
const POINT_PARK_METERS = 150
/** A big city's query can take longer than SCENIC.queryTimeoutSeconds: OVERPASS_TIMEOUT_S=120 npm run update-scenic -- <id>. */
const QUERY_TIMEOUT_S = Number(process.env.OVERPASS_TIMEOUT_S) || SCENIC.queryTimeoutSeconds
const SPACING_MS = 5_000
const RETRY_AFTER_MS = 30_000
const EARTH_RADIUS_M = 6_371_008.8

const SYSTEMS = fileURLToPath(new URL('../src/data/systems.json', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../src/data/scenic/', import.meta.url))

// ─── Pure helpers (exported for tests) ─────────────────────────────────────────────────────────

const toRad = (deg) => (deg * Math.PI) / 180
export const round5 = (n) => Math.round(n * 1e5) / 1e5

/** Great-circle distance in meters between [lon, lat] points. */
export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** [west, south, east, north] padded by `meters` on every side. */
export function padBbox([w, s, e, n], meters) {
  const dLat = meters / 111_320
  const dLon = meters / (111_320 * Math.cos(toRad((s + n) / 2)))
  return [w - dLon, s - dLat, e + dLon, n + dLat]
}

/** The Overpass QL query for one city's box ([west, south, east, north]; Overpass wants south, west, north, east). */
export function overpassQuery(bbox, timeoutSeconds = SCENIC.queryTimeoutSeconds) {
  const [w, s, e, n] = bbox.map((v) => v.toFixed(5))
  const b = `${s},${w},${n},${e}`
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    `(way["highway"="cycleway"](${b});way["highway"~"^(path|footway)$"]["bicycle"~"^(designated|yes|permissive)$"](${b}););`,
    'out geom qt;',
    `(nwr["leisure"~"^(park|nature_reserve|garden)$"]["name"](${b});nwr["natural"="beach"](${b});nwr["boundary"="national_park"](${b}););`,
    'out tags bb qt;',
    `node["tourism"="viewpoint"](${b});`,
    'out qt;',
    `(way["natural"="water"]["name"](${b});relation["natural"="water"]["name"](${b});way["waterway"="river"]["name"](${b});way["waterway"="riverbank"]["name"](${b}););`,
    'out geom qt;',
  ].join('\n')
}

/** Surfaces a BCycle city bike (or an e-bike with city tires) shouldn't be sent onto. */
const ROUGH_SURFACE = /^(dirt|earth|ground|grass|mud|sand|rock|rocks|pebblestone|woodchips|unpaved)$/
/**
 * A trail a BCycle bike belongs on: not singletrack (mtb:scale, "mountain bike" in the name), not rough or unpaved,
 * not a farm or forest track.
 */
export function cityBikeTrail(t, name) {
  if (t.highway === 'track' || t['mtb:scale'] !== undefined || /mountain bike|\bmtb\b/i.test(name)) return false
  return !ROUGH_SURFACE.test(t.surface ?? '')
}

const tagsOf = (el) => (el && typeof el.tags === 'object' && el.tags !== null ? el.tags : {})
const lineOf = (geometry) =>
  Array.isArray(geometry) ? geometry.filter((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat)).map((p) => [p.lon, p.lat]) : []

/** Points every `every` meters along a line (at least its midpoint when it is long enough to count). */
export function sampleLine(line, every = SCENIC.sampleEveryMeters, minMeters = MIN_WAY_METERS) {
  if (line.length < 2) return []
  const cum = [0]
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]))
  const total = cum[cum.length - 1]
  if (total < minMeters) return []
  const k = Math.max(1, Math.floor(total / every))
  const out = []
  for (let j = 0; j < k; j++) {
    const at = ((j + 0.5) * total) / k
    let i = 1
    while (i < cum.length - 1 && cum[i] < at) i++
    const seg = cum[i] - cum[i - 1] || 1
    const t = (at - cum[i - 1]) / seg
    const a = line[i - 1]
    const b = line[i]
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

/** A coarse grid of points for "anything within r meters?" lookups. */
function grid(cellDeg = 0.005) {
  const cells = new Map()
  const key = (x, y) => `${x}:${y}`
  return {
    add(c, value) {
      const k = key(Math.floor(c[0] / cellDeg), Math.floor(c[1] / cellDeg))
      if (!cells.has(k)) cells.set(k, [])
      cells.get(k).push({ c, value })
    },
    /** The nearest item within `meters` of c, or null. */
    nearest(c, meters) {
      const x = Math.floor(c[0] / cellDeg)
      const y = Math.floor(c[1] / cellDeg)
      let best = null
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const item of cells.get(key(x + dx, y + dy)) ?? []) {
            const d = haversine(c, item.c)
            if (d <= meters && (!best || d < best.d)) best = { d, value: item.value }
          }
      return best?.value ?? null
    },
  }
}

/**
 * Overpass JSON → ScenicData (src/routing/scenic.ts): `places` are the names of scenic features ([name, kind],
 * kind p = park/beach, w = water, v = viewpoint), `trails` the trail names, and `points` the candidate waypoints
 * [lon, lat, score, trail index or -1, place index or -1], best first, at most SCENIC.maxPoints.
 */
export function summarize(json, systemId, generatedOn) {
  const elements = Array.isArray(json?.elements) ? json.elements : []
  const places = []
  const placeIndex = new Map()
  const placeId = (name, kind) => {
    const k = `${kind}|${name}`
    if (!placeIndex.has(k)) {
      placeIndex.set(k, places.length)
      places.push([name, kind])
    }
    return placeIndex.get(k)
  }
  const trails = []
  const trailIndex = new Map()
  const trailId = (name) => {
    if (!trailIndex.has(name)) {
      trailIndex.set(name, trails.length)
      trails.push(name)
    }
    return trailIndex.get(name)
  }

  const water = grid()
  const viewpoints = grid()
  const parks = []
  const trailLines = []
  for (const el of elements) {
    const t = tagsOf(el)
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, 80) : ''
    if (el.type === 'way' && /^(cycleway|path|footway|track)$/.test(t.highway ?? '')) {
      if (!cityBikeTrail(t, name)) continue
      const line = lineOf(el.geometry)
      if (line.length >= 2) trailLines.push({ line, name })
    } else if (t.natural === 'water' || t.waterway === 'river' || t.waterway === 'riverbank') {
      if (!name) continue
      const id = placeId(name, 'w')
      const lines = el.type === 'relation' ? (el.members ?? []).map((m) => lineOf(m.geometry)) : [lineOf(el.geometry)]
      // Shore points about every 100 m: close enough for "within 150 m of the water".
      for (const line of lines) for (const c of sampleLine(line, 100, 0)) water.add(c, id)
      for (const line of lines) if (line.length) water.add(line[0], id)
    } else if (t.tourism === 'viewpoint' && el.type === 'node' && Number.isFinite(el.lon) && Number.isFinite(el.lat)) {
      viewpoints.add([el.lon, el.lat], placeId(name || 'viewpoint', 'v'))
    } else if (/^(park|nature_reserve|garden)$/.test(t.leisure ?? '') || t.natural === 'beach' || t.boundary === 'national_park') {
      const label = name || (t.natural === 'beach' ? 'beach' : '')
      if (!label) continue
      const id = placeId(label, 'p')
      if (el.type === 'node' && Number.isFinite(el.lon)) {
        const d = POINT_PARK_METERS / 111_320
        parks.push({ box: [el.lon - d / Math.cos(toRad(el.lat)), el.lat - d, el.lon + d / Math.cos(toRad(el.lat)), el.lat + d], id })
      } else if (el.bounds) {
        const { minlon, minlat, maxlon, maxlat } = el.bounds
        if ([minlon, minlat, maxlon, maxlat].every(Number.isFinite)) parks.push({ box: [minlon, minlat, maxlon, maxlat], id })
      }
    }
  }
  // The smallest box first: a point in a garden inside a big park is "in the garden".
  parks.sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))
  const inPark = (c) => parks.find((p) => c[0] >= p.box[0] && c[0] <= p.box[2] && c[1] >= p.box[1] && c[1] <= p.box[3])?.id ?? null

  const S = SCENIC.score
  const points = []
  for (const { line, name } of trailLines) {
    const trail = name ? trailId(name) : -1
    for (const c of sampleLine(line)) {
      let score = 1 + (name ? S.namedRoute : 0)
      let place = -1
      let placeScore = 0
      const v = viewpoints.nearest(c, SCENIC.viewpointMeters)
      const w = water.nearest(c, SCENIC.waterMeters)
      const p = inPark(c)
      if (v !== null) {
        score += S.viewpoint
        if (S.viewpoint > placeScore) [place, placeScore] = [v, S.viewpoint]
      }
      if (w !== null) {
        score += S.water
        if (S.water > placeScore) [place, placeScore] = [w, S.water]
      }
      if (p !== null) {
        score += S.park
        if (S.park > placeScore) [place, placeScore] = [p, S.park]
      }
      points.push([round5(c[0]), round5(c[1]), score, trail, place])
    }
  }
  // Best first (stable), capped; only the places and trails still referenced are kept.
  const kept = points.map((p, i) => [p, i]).sort((a, b) => b[0][2] - a[0][2] || a[1] - b[1]).slice(0, SCENIC.maxPoints).map(([p]) => p)
  const usedPlaces = new Map()
  const usedTrails = new Map()
  const remap = (map, i) => {
    if (i < 0) return -1
    if (!map.has(i)) map.set(i, map.size)
    return map.get(i)
  }
  const outPoints = kept.map(([lon, lat, score, trail, place]) => [lon, lat, score, remap(usedTrails, trail), remap(usedPlaces, place)])
  return {
    v: 1,
    systemId,
    generatedOn,
    places: [...usedPlaces.keys()].map((i) => places[i]),
    trails: [...usedTrails.keys()].map((i) => trails[i]),
    points: outPoints,
  }
}

// ─── Network ────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function queryOverpass(query) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout((QUERY_TIMEOUT_S + 35) * 1000),
    })
    // Overpass asks clients to back off on 429 (too many requests) and 504 (server too busy for the query); the
    // public instance also answers 502/503 when overloaded.
    if ([429, 502, 503, 504].includes(res.status) && attempt < 3) {
      console.warn(`  Overpass answered ${res.status}; waiting ${RETRY_AFTER_MS / 1000} s`)
      await sleep(RETRY_AFTER_MS)
      continue
    }
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
    return res.json()
  }
}

async function main() {
  const systems = JSON.parse(await readFile(SYSTEMS, 'utf8'))
  const wanted = process.argv.slice(2)
  const todo = systems.filter((s) => (wanted.length ? wanted.includes(s.id) : s.active))
  if (!todo.length) throw new Error('No matching systems')
  await mkdir(OUT_DIR, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  let failed = 0
  for (const [i, sys] of todo.entries()) {
    if (i > 0) await sleep(SPACING_MS)
    try {
      const json = await queryOverpass(overpassQuery(padBbox(sys.bbox, SCENIC.bboxPadMeters), QUERY_TIMEOUT_S))
      if (json?.remark && !json.elements?.length) throw new Error(`Overpass: ${json.remark}`)
      const data = summarize(json, sys.id, today)
      await writeFile(`${OUT_DIR}${sys.id}.json`, `${JSON.stringify(data)}\n`)
      console.log(`${sys.id}: ${data.points.length} points, ${data.trails.length} trails, ${data.places.length} places`)
    } catch (err) {
      failed++
      console.error(`${sys.id}: ${err instanceof Error ? err.message : err} (previous file, if any, kept)`)
    }
  }
  if (failed) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
