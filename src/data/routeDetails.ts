// Path breakdown + elevation (+ colored segments) for the chosen route, shared by the planner card and
// the map through React Query's cache: one request per route.
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '../api/client'
import { ROUTE_DETAILS } from '../config'
import { haversine } from '../lib/geo'
import { encodePolyline } from '../lib/polyline'
import type { LngLat, RouteLeg } from '../types'

/** Points at least `minMeters` apart (always keeping the ends): small enough to send, still easy to map-match. */
export function thinRoute(coords: readonly LngLat[], minMeters: number = ROUTE_DETAILS.thinMeters): LngLat[] {
  if (coords.length <= 2) return [...coords]
  const out: LngLat[] = [coords[0]!]
  for (let i = 1; i < coords.length - 1; i++) if (haversine(out.at(-1)!, coords[i]!) >= minMeters) out.push(coords[i]!)
  out.push(coords.at(-1)!)
  return out
}

export function useRouteDetails(systemId: string | null, route: RouteLeg | null) {
  const polyline = useMemo(() => (route ? encodePolyline(thinRoute(route.geometry), 6) : null), [route])
  const enabled = !!systemId && !!polyline
  const q = useQuery({
    queryKey: ['routeDetails', systemId, polyline],
    queryFn: ({ signal }) => api.routeDetails(systemId!, polyline!, signal),
    enabled,
    staleTime: Infinity,
    gcTime: ROUTE_DETAILS.cacheMs,
    retry: false,
  })
  // A disabled query (no city yet) is not "loading". A failure (the routing server was busy) can be retried.
  return {
    details: q.data,
    pending: enabled && q.isPending,
    failed: q.isError,
    retrying: q.isError && q.isFetching,
    retry: () => {
      void q.refetch()
    },
  }
}
