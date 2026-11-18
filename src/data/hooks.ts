// React Query hooks for server data. React Query owns server state; components key effects on the
// snapshot `revision`, never on object identity.
import { QueryClient, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { MetaResponse, StationsResponse } from '../api/contract'
import { POLL } from '../config'
import { AppError, toAppError } from '../lib/errors'
import type { ClientStationsSnapshot, SystemDetails } from '../types'
import { freshnessOf, statusPollInterval, toClientSnapshot, type Freshness } from './snapshot'
import { recordSnapshot } from './trend'

export const qk = {
  stations: (systemId: string) => ['stations', systemId] as const,
  system: (systemId: string) => ['system', systemId] as const,
  meta: () => ['meta'] as const,
  geocode: (systemId: string, query: string, nearKey: string) => ['geocode', systemId, query, nearKey] as const,
  reverse: (lon5: string, lat5: string) => ['reverse', lon5, lat5] as const,
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Each hook sets its own retry/refetch policy; routing never retries via React Query.
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
}

const retryable = (failureCount: number, err: unknown, max: number) => err instanceof AppError && err.retryable && err.code !== 'rate_limited' && failureCount < max

/**
 * Re-renders every `intervalMs` with the current time (for freshness/age displays and timers). With
 * `enabled` false it stops ticking (no re-renders), and catches up as soon as it is enabled again.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const tick = () => setNow(Date.now())
    tick()
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
  return now
}

// Client snapshots are derived once per response and shared by every subscriber (identity-stable).
const snapshotCache = new Map<string, ClientStationsSnapshot>()
function selectSnapshot(data: StationsResponse): ClientStationsSnapshot {
  const prev = snapshotCache.get(data.systemId) ?? null
  const next = toClientSnapshot(data, prev)
  if (next !== prev) {
    snapshotCache.set(data.systemId, next)
    recordSnapshot(next)
  }
  return next
}

/** The latest client snapshot for a system, outside React (event handlers); undefined before the first. */
export function latestSnapshot(systemId: string | null): ClientStationsSnapshot | undefined {
  return systemId ? snapshotCache.get(systemId) : undefined
}

/** The stations request (shared by useStationsSnapshot and the startup prefetch, so they are one request). */
const stationsQuery = (systemId: string) => ({
  queryKey: qk.stations(systemId),
  queryFn: ({ signal }: { signal: AbortSignal }) => api.stations(systemId, signal),
  staleTime: POLL.statusMinMs,
  retry: (n: number, err: unknown) => retryable(n, err, 3),
})

/**
 * Starts loading a system's stations before React's first render (the launch screen waits for them). The
 * hooks pick up the same request.
 */
export function prefetchStations(client: QueryClient, systemId: string | null): void {
  if (systemId) void client.prefetchQuery(stationsQuery(systemId))
}

export interface StationsQuery {
  snapshot: ClientStationsSnapshot | undefined
  /** As of the last response; displays that show it over time age it on their own clock (FreshnessBadge). */
  freshness: Freshness
  error: AppError | null
  isFetching: boolean
  refetch: () => void
}

/**
 * Live stations for a system. Polls right after each feed refresh is expected (see
 * statusPollInterval); `active` (navigating / StationCard open) caps the interval lower. Keeps the last
 * good snapshot when a poll fails (freshness becomes 'stale'). Re-renders only when the data or the request
 * state changes (no timers: many always-mounted components use this).
 */
export function useStationsSnapshot(systemId: string | null, opts: { active?: boolean } = {}): StationsQuery {
  const active = opts.active ?? false
  const q = useQuery({
    ...stationsQuery(systemId ?? '-'),
    enabled: systemId !== null,
    select: selectSnapshot,
    refetchInterval: (query) => statusPollInterval(query.state.data?.lastUpdatedMs, Date.now(), active),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  return {
    snapshot: q.data,
    freshness: freshnessOf({ hasData: q.data !== undefined, isError: q.isError, lastUpdatedMs: q.data?.lastUpdatedMs, nowMs: q.dataUpdatedAt }),
    error: q.error ? toAppError(q.error) : null,
    isFetching: q.isFetching,
    refetch: () => {
      void q.refetch()
    },
  }
}

/** System details (passes, contact, app links). `enabled` false: no request, but cached data is returned. */
export function useSystemDetails(systemId: string | null, enabled = true): { details: SystemDetails | undefined; error: AppError | null } {
  const q = useQuery({
    queryKey: qk.system(systemId ?? '-'),
    queryFn: ({ signal }) => api.system(systemId as string, signal),
    enabled: systemId !== null && enabled,
    staleTime: POLL.systemDetailsStaleMs,
    gcTime: 2 * POLL.systemDetailsStaleMs,
    retry: (n, err) => retryable(n, err, 2),
  })
  return { details: q.data, error: q.error ? toAppError(q.error) : null }
}

export function useMeta(): MetaResponse | undefined {
  const q = useQuery({
    queryKey: qk.meta(),
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: Infinity,
    retry: (n, err) => retryable(n, err, 2),
  })
  return q.data
}
