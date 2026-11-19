// Debounced place search (Photon directly, falling back to /api/geocode; see api.geocode) and reverse
// geocoding via the Worker (/api/reverse).
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { GEOCODE } from '../config'
import { qk } from '../data/hooks'
import { AppError, toAppError } from '../lib/errors'
import type { LngLat, Place } from '../types'
import { normalizeQuery } from './photon'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

export { normalizeQuery }

/**
 * Places matching `query` in/near the system. Waits GEOCODE.debounceMs and GEOCODE.minChars; `near`
 * (user position) biases results but is rounded (~1 km) in the cache key so GPS jitter does not refetch.
 */
export function useGeocodeSearch(query: string, systemId: string | null, near: LngLat | null): { places: Place[]; loading: boolean; error: AppError | null } {
  const debounced = useDebouncedValue(normalizeQuery(query), GEOCODE.debounceMs)
  const enabled = systemId !== null && debounced.length >= GEOCODE.minChars
  const nearKey = near ? `${near[0].toFixed(2)},${near[1].toFixed(2)}` : '-'
  const q = useQuery({
    queryKey: qk.geocode(systemId ?? '-', debounced.toLowerCase(), nearKey),
    queryFn: ({ signal }) => api.geocode(debounced, systemId as string, near, signal),
    enabled,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    // api.geocode already falls back from Photon to the Worker; retrying on top only makes a miss slower.
    retry: false,
  })
  return {
    places: enabled ? (q.data ?? []) : [],
    loading: enabled && (q.isFetching || debounced !== normalizeQuery(query)),
    error: q.error ? toAppError(q.error) : null,
  }
}

/** Reverse geocode for a dropped pin; null place means "Dropped pin". */
export function useReverseGeocode(coord: LngLat | null): { place: Place | null; loading: boolean } {
  const lon5 = coord ? coord[0].toFixed(5) : '-'
  const lat5 = coord ? coord[1].toFixed(5) : '-'
  const q = useQuery({
    queryKey: qk.reverse(lon5, lat5),
    queryFn: ({ signal }) => api.reverse(coord as LngLat, signal),
    enabled: coord !== null,
    staleTime: 60 * 60_000,
    retry: false,
  })
  return { place: q.data ?? null, loading: coord !== null && q.isFetching }
}
