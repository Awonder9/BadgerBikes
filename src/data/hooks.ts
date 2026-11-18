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

/** Re-renders every `intervalMs` with the current time (for freshness/age displays). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
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

export interface StationsQuery {
  snapshot: ClientStationsSnapshot | undefined
  freshness: Freshness
  error: AppError | null
  isFetching: boolean
  refetch: () => void
}

/**
 * Live stations for a system. Polls right after each feed refresh is expected (see
 * statusPollInterval); `active` (navigating / StationCard open) caps the interval lower. Keeps the last
 * good snapshot when a poll fails (freshness becomes 'stale').
 */
export function useStationsSnapshot(systemId: string | null, opts: { active?: boolean } = {}): StationsQuery {
  const active = opts.active ?? false
  const now = useNow(10_000)
  const q = useQuery({
    queryKey: qk.stations(systemId ?? '-'),
    queryFn: ({ signal }) => api.stations(systemId as string, signal),
    enabled: systemId !== null,
    select: selectSnapshot,
    refetchInterval: (query) => statusPollInterval(query.state.data?.lastUpdatedMs, Date.now(), active),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: POLL.statusMinMs,
    retry: (n, err) => retryable(n, err, 3),
  })
  return {
    snapshot: q.data,
    freshness: freshnessOf({ hasData: q.data !== undefined, isError: q.isError, lastUpdatedMs: q.data?.lastUpdatedMs, nowMs: now }),
    error: q.error ? toAppError(q.error) : null,
    isFetching: q.isFetching,
    refetch: () => {
      void q.refetch()
    },
  }
}

export function useSystemDetails(systemId: string | null): { details: SystemDetails | undefined; error: AppError | null } {
  const q = useQuery({
    queryKey: qk.system(systemId ?? '-'),
    queryFn: ({ signal }) => api.system(systemId as string, signal),
    enabled: systemId !== null,
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
