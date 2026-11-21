// Routed legs that are only drawn (POST /api/route): the walks to the pickup dock and from the end dock, and the
// ride's last stretch to an off-route end dock. Shared through React Query's cache (one request per leg), asked at
// background priority; until one arrives — or when the routers can't — the map keeps the straight line.
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { APP, ROUTE_DETAILS } from '../config'
import type { LegRole, LngLat, RouteLeg, TravelMode } from '../types'

export interface LegRequest {
  role: LegRole
  mode: TravelMode
  from: LngLat
  to: LngLat
  fromIsUserPoint?: boolean
  toIsUserPoint?: boolean
}

/** ~1 m: positions that differ by less share a request. */
const key = (c: LngLat) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`

/** The routed leg's geometry, or undefined while it loads or when it couldn't be routed. */
export function useLegRoute(systemId: string | null, req: LegRequest | null): LngLat[] | undefined {
  const q = useQuery({
    queryKey: ['leg', systemId, req && `${req.mode}|${req.role}|${key(req.from)}|${key(req.to)}`],
    queryFn: async ({ signal }): Promise<RouteLeg> => {
      // Geometry only: units don't matter, so one fixed value keeps the server's cache shared.
      const leg = await api.route({ systemId: systemId!, ...req!, units: 'metric', language: APP.language, priority: 'background' }, signal)
      // Both routers failed: no better than the line already drawn. An error (not data) is tried again later.
      if (leg.provider === 'straight') throw new Error('not routed')
      return leg
    },
    enabled: !!systemId && !!req,
    staleTime: Infinity,
    gcTime: ROUTE_DETAILS.cacheMs,
    retry: false,
  })
  return q.data?.geometry
}
