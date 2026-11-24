// "Just ride": where a ride with no destination goes. Picks waypoints on scenic trails (src/routing/scenic.ts) so the
// route through them — routed at LOOP.useRoads, as far from cars as the network allows — is about the length the
// rider asked for: back to the start (a triangle start → A → B → start) or ending at another dock with space
// (start → A → that dock). The routing server then draws the actual streets and paths (POST /api/loop).
// Pure: no DOM, no network; `seed` makes the choice repeatable ("Try another" changes it).
import { LOOP } from '../config'
import { bearing, bearingDelta, destination, haversine } from '../lib/geo'
import type { LngLat } from '../types'
import type { ScenicPoint } from './scenic'

export interface LoopVia {
  coord: LngLat
  /** Not a trail point (no scenic point fit): it may lie off any street, so the router may snap it further. */
  synthetic: boolean
}

export interface LoopPlan {
  via: LoopVia[]
  /** The dock the ride ends at, or null: back to the start. */
  end: { id: string; coord: LngLat } | null
  /** Asked for one way, but no dock with space was in range: the plan is a loop back to the start. */
  fellBackToRoundTrip: boolean
}

export interface LoopInput {
  start: LngLat
  /** Wanted riding distance, meters. */
  targetMeters: number
  roundTrip: boolean
  seed: number
  points: readonly ScenicPoint[]
  /** Docks the ride may end at (with space for the party), the start dock excluded. */
  endDocks: ReadonlyArray<{ id: string; coord: LngLat }>
  /**
   * Straight-line size factor: 1 at first; after routing, target ÷ routed length (a loop that came out too long or
   * too short is planned again at a corrected size).
   */
  scale?: number
}

/** A small, fast seeded PRNG (mulberry32): the same seed always picks the same loop. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Weighted {
  p: ScenicPoint
  /** Score plus a seeded jitter, so equally nice points take turns. */
  w: number
  d: number
}

/** Scenic points between `lo` and `hi` meters from `from`, best (jittered) first, at most `n`. */
function ring(points: readonly ScenicPoint[], from: LngLat, lo: number, hi: number, n: number, rnd: () => number): Weighted[] {
  const out: Weighted[] = []
  for (const p of points) {
    const d = haversine(from, p.coord)
    if (d >= lo && d <= hi) out.push({ p, d, w: p.score + rnd() * 3 })
  }
  return out.sort((a, b) => b.w - a.w).slice(0, n)
}

const real = (p: ScenicPoint): LoopVia => ({ coord: p.coord, synthetic: false })
const made = (c: LngLat): LoopVia => ({ coord: c, synthetic: true })

/** Start → A → B → start, its straight-line perimeter close to `perimeter`, A and B as scenic as possible. */
function roundTrip(input: LoopInput, perimeter: number, rnd: () => number): LoopVia[] {
  const { start, points } = input
  const side = perimeter / 3
  const cands = ring(points, start, side * 0.5, side * 1.5, LOOP.candidatesPerPick, rnd)
  let best: { v: number; a: Weighted; b: Weighted } | null = null
  for (const a of cands) {
    for (const b of cands) {
      if (a === b) continue
      const ab = haversine(a.p.coord, b.p.coord)
      // A real triangle: the two legs out leave at clearly different angles (not out and back on one line).
      const spread = bearingDelta(bearing(start, a.p.coord), bearing(start, b.p.coord))
      if (ab < side * 0.3 || spread < 30 || spread > 130) continue
      const off = Math.abs(a.d + ab + b.d - perimeter) / perimeter
      const v = a.w + b.w - 12 * off
      if (!best || v > best.v) best = { v, a, b }
    }
  }
  if (best && Math.abs(best.a.d + haversine(best.a.p.coord, best.b.p.coord) + best.b.d - perimeter) / perimeter < 0.35) {
    return [real(best.a.p), real(best.b.p)]
  }
  // Too few trails in range: an equilateral triangle in a seeded direction, through the best trail point if any.
  const a = cands[0]
  const heading = a ? bearing(start, a.p.coord) : rnd() * 360
  const turn = rnd() < 0.5 ? 60 : -60
  return [a ? real(a.p) : made(destination(start, side, heading)), made(destination(start, side, heading + turn))]
}

/** Start → A → end dock, about `length` meters in a straight line, ending well away from the start. */
function oneWay(input: LoopInput, length: number, rnd: () => number): { via: LoopVia[]; end: { id: string; coord: LngLat } } | null {
  const { start, points, endDocks } = input
  const ends = endDocks.filter((e) => {
    const d = haversine(start, e.coord)
    return d >= length * LOOP.oneWayMinEndFraction && d <= length * 0.95
  })
  if (ends.length === 0) return null
  const cands = ring(points, start, length * 0.15, length * 0.85, LOOP.candidatesPerPick * 2, rnd)
  let best: { v: number; a: Weighted | null; e: (typeof ends)[number] } | null = null
  for (const e of ends) {
    const jitter = rnd()
    for (const a of cands) {
      const total = a.d + haversine(a.p.coord, e.coord)
      const off = Math.abs(total - length) / length
      // Out to A and back past the start isn't a ride somewhere: A lies roughly toward the end dock.
      if (bearingDelta(bearing(start, a.p.coord), bearing(start, e.coord)) > 100) continue
      const v = a.w - 12 * off + jitter
      if (!best || v > best.v) best = { v, a, e }
    }
    if (!best) best = { v: -Infinity, a: null, e }
  }
  if (!best) return null
  if (best.a && Math.abs(best.a.d + haversine(best.a.p.coord, best.e.coord) - length) / length < 0.35) return { via: [real(best.a.p)], end: best.e }
  // No trail point fits: bow the route out to one side so start → via → end is about the wanted length.
  const chord = haversine(start, best.e.coord)
  const mid: LngLat = [(start[0] + best.e.coord[0]) / 2, (start[1] + best.e.coord[1]) / 2]
  const bow = Math.sqrt(Math.max(0, (length / 2) ** 2 - (chord / 2) ** 2))
  return { via: bow > 50 ? [made(destination(mid, bow, bearing(start, best.e.coord) + (rnd() < 0.5 ? 90 : -90)))] : [], end: best.e }
}

/** The waypoints (and end dock) of a ride of about `targetMeters`; see LoopInput. */
export function planLoop(input: LoopInput): LoopPlan {
  const rnd = seededRandom(input.seed)
  const straight = (input.targetMeters / LOOP.detourFactor) * (input.scale ?? 1)
  if (!input.roundTrip) {
    const one = oneWay(input, straight, rnd)
    if (one) return { ...one, fellBackToRoundTrip: false }
    return { via: roundTrip(input, straight, rnd), end: null, fellBackToRoundTrip: true }
  }
  return { via: roundTrip(input, straight, rnd), end: null, fellBackToRoundTrip: false }
}

/** The riding distance for `minutes` at `kph` (the routers' bike speed), meters. */
export const loopTargetMeters = (minutes: number, kph: number): number => ((minutes * 60) * kph) / 3.6
