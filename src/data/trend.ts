// In-session availability trends ("▼3 bikes in 10 min") from the snapshots this tab has seen.
// Module-level ring buffers keyed by `${systemId}:${stationId}`; no backend needed.
import { UI } from '../config'
import type { ClientStationsSnapshot } from '../types'

export interface TrendPoint {
  tMs: number
  bikes: number
  docks: number
}

const buffers = new Map<string, TrendPoint[]>()
const recorded = new Map<string, number>() // systemId → last recorded lastUpdatedMs

/** Records one point per station for each distinct feed time (call on every new snapshot). */
export function recordSnapshot(s: ClientStationsSnapshot, capacity: number = UI.trendSnapshots): void {
  if (recorded.get(s.systemId) === s.lastUpdatedMs) return
  recorded.set(s.systemId, s.lastUpdatedMs)
  for (const st of s.stations) {
    if (!st.status) continue
    const key = `${s.systemId}:${st.id}`
    const buf = buffers.get(key) ?? []
    buf.push({ tMs: s.lastUpdatedMs, bikes: st.status.bikes, docks: st.status.docks })
    if (buf.length > capacity) buf.splice(0, buf.length - capacity)
    buffers.set(key, buf)
  }
}

export function getTrend(systemId: string, stationId: string): readonly TrendPoint[] {
  return buffers.get(`${systemId}:${stationId}`) ?? []
}

/**
 * Change in `kind` over the last `windowMs` (latest − earliest point inside the window), or null when
 * there are fewer than 2 points spanning at least a third of the window.
 */
export function trendDelta(points: readonly TrendPoint[], kind: 'bikes' | 'docks', windowMs: number): { delta: number; spanMs: number } | null {
  const last = points[points.length - 1]
  if (!last) return null
  const inWindow = points.filter((p) => last.tMs - p.tMs <= windowMs)
  const first = inWindow[0]
  if (!first || inWindow.length < 2) return null
  const spanMs = last.tMs - first.tMs
  if (spanMs < windowMs / 3) return null
  return { delta: last[kind] - first[kind], spanMs }
}

/** Test hook. */
export function resetTrends(): void {
  buffers.clear()
  recorded.clear()
}
