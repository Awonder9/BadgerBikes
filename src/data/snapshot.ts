// Pure helpers behind useStationsSnapshot: change tracking and poll cadence.
import type { StationsResponse } from '../api/contract'
import { POLL } from '../config'
import type { ClientStationsSnapshot, Station, StationStatus } from '../types'

function sameStatus(a: StationStatus | null, b: StationStatus | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.bikes === b.bikes &&
    a.docks === b.docks &&
    a.ebikes === b.ebikes &&
    a.classic === b.classic &&
    a.isInstalled === b.isInstalled &&
    a.isRenting === b.isRenting &&
    a.isReturning === b.isReturning
  )
}

function sameInfo(a: Station, b: Station): boolean {
  return a.name === b.name && a.coord[0] === b.coord[0] && a.coord[1] === b.coord[1] && a.hasKiosk === b.hasKiosk && a.address === b.address
}

/**
 * Builds a client snapshot from an API response. `revision` increments only when some station's
 * counts/flags/info changed (or stations appeared/disappeared); when nothing changed the previous
 * snapshot object is returned (identity-stable) unless only the feed time moved.
 */
export function toClientSnapshot(res: StationsResponse, prev: ClientStationsSnapshot | null): ClientStationsSnapshot {
  const usablePrev = prev && prev.systemId === res.systemId ? prev : null
  const byId = new Map<string, Station>()
  const changedIds = new Set<string>()
  for (const st of res.stations) {
    byId.set(st.id, st)
    const old = usablePrev?.byId.get(st.id)
    if (!old || !sameStatus(old.status, st.status) || !sameInfo(old, st)) changedIds.add(st.id)
  }
  if (usablePrev) for (const id of usablePrev.byId.keys()) if (!byId.has(id)) changedIds.add(id)

  if (usablePrev && changedIds.size === 0) {
    if (usablePrev.lastUpdatedMs === res.lastUpdatedMs) return usablePrev
    return { ...usablePrev, lastUpdatedMs: res.lastUpdatedMs, fetchedAtMs: res.fetchedAtMs, changedIds: new Set() }
  }
  return {
    systemId: res.systemId,
    stations: res.stations,
    byId,
    lastUpdatedMs: res.lastUpdatedMs,
    fetchedAtMs: res.fetchedAtMs,
    revision: usablePrev ? usablePrev.revision + 1 : 1,
    changedIds,
  }
}

/**
 * Next station_status poll delay: right after the feed's CDN entry should expire
 * (lastUpdated + statusAfterFeedMs), clamped; slower when the feed itself is stale; capped while the
 * rider is actively relying on counts (navigating / StationCard open).
 */
export function statusPollInterval(lastUpdatedMs: number | undefined, nowMs: number, active: boolean): number {
  const max = active ? POLL.statusActiveMaxMs : POLL.statusMaxMs
  if (!lastUpdatedMs) return Math.min(max, 30_000)
  const age = nowMs - lastUpdatedMs
  if (age > POLL.staleAfterMs) return Math.min(max, 30_000)
  const untilRefresh = lastUpdatedMs + POLL.statusAfterFeedMs - nowMs
  return Math.min(max, Math.max(POLL.statusMinMs, untilRefresh))
}

export type Freshness = 'loading' | 'fresh' | 'stale' | 'error'

export function freshnessOf(input: { hasData: boolean; isError: boolean; lastUpdatedMs: number | undefined; nowMs: number }): Freshness {
  if (!input.hasData) return input.isError ? 'error' : 'loading'
  if (input.isError) return 'stale'
  if (input.lastUpdatedMs !== undefined && input.nowMs - input.lastUpdatedMs > POLL.staleAfterMs) return 'stale'
  return 'fresh'
}
