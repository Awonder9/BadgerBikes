// A city's bike trails and scenic places (src/data/scenic/<system id>.json, made by `npm run update-scenic` from
// OpenStreetMap through Overpass): candidate waypoints for "Just ride" loops and the names a ride passes.
// Pure: no DOM, no network.
import { bboxContains, bboxOf, buildPolylineIndex, isValidLngLat, nearestOnPolyline } from '../lib/geo'
import type { LngLat } from '../types'

/** The generated file (scripts/update-scenic.mjs `summarize`). */
export interface ScenicData {
  v: 1
  systemId: string
  /** YYYY-MM-DD */
  generatedOn: string
  /** [name, kind]: p = park or beach, w = water, v = viewpoint (name "viewpoint" = an unnamed one). */
  places: Array<[string, 'p' | 'w' | 'v']>
  trails: string[]
  /** [lon, lat, score, trail index or -1, place index or -1], best first. */
  points: Array<[number, number, number, number, number]>
}

export type HighlightKind = 'trail' | 'park' | 'water' | 'viewpoint'

export interface Highlight {
  kind: HighlightKind
  /** Empty for an unnamed viewpoint (the UI says "a viewpoint"). */
  name: string
}

/** A candidate waypoint on a trail: higher scores are nicer (by water, in a park, near a viewpoint, named). */
export interface ScenicPoint {
  coord: LngLat
  score: number
  trail: string | null
  place: Highlight | null
}

const KINDS = { p: 'park', w: 'water', v: 'viewpoint' } as const

/** The generated file → points; anything malformed is skipped (an empty list means "no scenery": loops still work). */
export function parseScenic(raw: unknown): ScenicPoint[] {
  if (typeof raw !== 'object' || raw === null) return []
  const d = raw as Partial<ScenicData>
  if (d.v !== 1 || !Array.isArray(d.points) || !Array.isArray(d.places) || !Array.isArray(d.trails)) return []
  const places = d.places
  const trails = d.trails
  const out: ScenicPoint[] = []
  for (const p of d.points) {
    if (!Array.isArray(p) || p.length < 5) continue
    const [lon, lat, score, ti, pi] = p
    const coord: LngLat = [lon, lat]
    if (!isValidLngLat(coord) || typeof score !== 'number' || !Number.isFinite(score)) continue
    const trail = typeof ti === 'number' && typeof trails[ti] === 'string' ? trails[ti] : null
    const place = typeof pi === 'number' ? places[pi] : undefined
    const kind = place && typeof place[0] === 'string' ? KINDS[place[1]] : undefined
    out.push({
      coord,
      score,
      trail,
      place: kind && place ? { kind, name: kind === 'viewpoint' && place[0] === 'viewpoint' ? '' : place[0] } : null,
    })
  }
  return out
}

/** How notable each kind is when choosing which highlights to name. */
const KIND_WEIGHT: Record<HighlightKind, number> = { viewpoint: 4, water: 3, park: 3, trail: 2 }

/**
 * The trails and scenic places `line` passes (scenic points within `maxMeters` of it), at most `max`, the most notable
 * first chosen and then listed in ride order. An unnamed viewpoint counts once.
 */
export function routeHighlights(line: readonly LngLat[], points: readonly ScenicPoint[], maxMeters: number, max: number): Highlight[] {
  if (line.length < 2 || points.length === 0) return []
  const index = buildPolylineIndex([...line])
  const box = bboxOf(index.coords)
  const seen = new Map<string, { h: Highlight; along: number; hits: number }>()
  const note = (h: Highlight, along: number) => {
    const key = `${h.kind}|${h.name}`
    const prev = seen.get(key)
    if (prev) {
      prev.hits++
      prev.along = Math.min(prev.along, along)
    } else seen.set(key, { h, along, hits: 1 })
  }
  for (const p of points) {
    if (box && !bboxContains(box, p.coord, maxMeters)) continue
    const snap = nearestOnPolyline(index, p.coord)
    if (!snap || snap.distanceFromLine > maxMeters) continue
    if (p.place) note(p.place, snap.distanceAlong)
    if (p.trail) note({ kind: 'trail', name: p.trail }, snap.distanceAlong)
  }
  return [...seen.values()]
    .sort((a, b) => KIND_WEIGHT[b.h.kind] + Math.min(b.hits, 6) - (KIND_WEIGHT[a.h.kind] + Math.min(a.hits, 6)))
    .slice(0, max)
    .sort((a, b) => a.along - b.along)
    .map((x) => x.h)
}
