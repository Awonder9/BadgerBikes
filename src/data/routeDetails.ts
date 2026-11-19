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

/**
 * The route as the polyline6 sent to POST /api/route-details: thinned to ROUTE_DETAILS.thinMeters, or coarser
 * for a long route until it fits the server's limits (ROUTE_DETAILS.maxPoints / maxPolylineChars) — a request
 * over them is refused every time, so its path details could never load.
 */
export function detailsPolyline(coords: readonly LngLat[]): string {
  let minMeters: number = ROUTE_DETAILS.thinMeters
  for (;;) {
    const thinned = thinRoute(coords, minMeters)
    const encoded = encodePolyline(thinned, 6)
    if ((thinned.length <= ROUTE_DETAILS.maxPoints && encoded.length <= ROUTE_DETAILS.maxPolylineChars) || thinned.length <= 2) return encoded
    minMeters *= 2
  }
}

export function useRouteDetails(systemId: string | null, route: RouteLeg | null) {
  const polyline = useMemo(() => (route ? detailsPolyline(route.geometry) : null), [route])
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
