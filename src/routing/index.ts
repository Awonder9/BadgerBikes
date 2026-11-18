// Router facade: Valhalla → OSRM → straight for routes, and the three bike route options.
// See ./types.ts for the rejection contract.
import { BIKE_ROUTING, CACHE_TTL_MS, ENDPOINTS } from '../config'
import { AppError, isAbort } from '../lib/errors'
import type { UpstreamFetch } from '../lib/upstream'
import type { LngLat, RouteLeg } from '../types'
import { mapOsrmError, normalizeOsrmRoute, osrmRouteUrl } from './osrm'
import { straightLeg } from './straight'
import type { AltRouter, RequestOpts, RouteRequest } from './types'
import { normalizeTraceAttributes, type RouteDetails } from './details'
import { mapValhallaError, normalizeValhallaRoute, routeBody, valhallaUrl } from './valhalla'

export interface RouterDeps {
  upstream: UpstreamFetch
  endpoints?: Pick<typeof ENDPOINTS, 'valhalla' | 'osrmBike' | 'osrmFoot'>
}

/** FNV-1a, for compact cache keys. */
function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

const r5 = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`
const aborted = () => new AppError('aborted', 'Aborted')

/** Errors that justify falling back to the next provider. */
function isFallbackable(err: unknown): boolean {
  if (!(err instanceof AppError)) return true
  if (err.code === 'location_unroutable' || err.code === 'aborted') return false
  return true
}

export function createRouter(deps: RouterDeps): AltRouter {
  const ep = deps.endpoints ?? ENDPOINTS
  const up = deps.upstream

  async function route(req: RouteRequest, opts: RequestOpts = {}): Promise<RouteLeg> {
    const priority = opts.priority ?? 'interactive'
    const keyTail = `${req.mode}|${req.bikeKind ?? 'classic'}|${req.useRoads ?? BIKE_ROUTING.defaultUseRoads}|${req.units}|${req.language}|${r5(req.from)}|${r5(req.to)}|${req.headingDeg ?? ''}`
    try {
      const json = await up<unknown>({
        url: valhallaUrl(ep.valhalla, 'route', routeBody(req)),
        group: 'fossgis',
        priority,
        provider: 'valhalla',
        signal: opts.signal,
        cacheKey: `valhalla|route|${keyTail}`,
        cacheTtlMs: CACHE_TTL_MS.route,
      })
      return normalizeValhallaRoute(json, req)
    } catch (e) {
      const err = mapValhallaError(e, req)
      if (isAbort(err) || opts.signal?.aborted) throw aborted()
      if (!isFallbackable(err)) throw err
    }
    try {
      const json = await up<unknown>({
        url: osrmRouteUrl(req.mode === 'bike' ? ep.osrmBike : ep.osrmFoot, req),
        group: 'fossgis',
        priority,
        provider: 'osrm',
        signal: opts.signal,
        cacheKey: `osrm|route|${keyTail}`,
        cacheTtlMs: CACHE_TTL_MS.route,
      })
      return normalizeOsrmRoute(json, req)
    } catch (e) {
      const err = mapOsrmError(e)
      if (isAbort(err) || opts.signal?.aborted) throw aborted()
      if (!isFallbackable(err)) throw err
    }
    return straightLeg(req)
  }

  /**
   * One bike route per use_roads level, in order (identical routes are kept so options stay positional; the
   * UI marks them). The last option is replaced by the quickest of all, so "Fastest" is always fastest.
   * A straight-line guess is useless for picking docks along the way, so when the routing servers are busy
   * (or down) this rejects with 'upstream_unavailable' and the rider is asked to retry shortly.
   */
  async function routeLadder(req: RouteRequest, levels: readonly number[], opts: RequestOpts = {}): Promise<RouteLeg[]> {
    const out: RouteLeg[] = []
    for (const useRoads of levels.slice(0, 3)) {
      const leg = { ...(await route({ ...req, useRoads }, opts)), useRoads }
      if (leg.provider === 'straight') throw new AppError('upstream_unavailable', 'The routing server is busy. Try again in a few seconds.', { retryable: true, provider: 'valhalla' })
      out.push(leg)
    }
    const quickest = out.reduce<RouteLeg | undefined>((m, l) => (!m || l.duration < m.duration ? l : m), undefined)
    if (out.length > 1 && quickest) out[out.length - 1] = quickest
    return out
  }

  async function routeDetails(polyline6: string, opts: RequestOpts = {}): Promise<RouteDetails> {
    const body = {
      encoded_polyline: polyline6,
      costing: 'bicycle',
      // walk_or_snap: our geometry has connectors from docks to the street, which an exact edge walk rejects.
      shape_match: 'walk_or_snap',
      filters: { attributes: ['shape', 'edge.length', 'edge.use', 'edge.cycle_lane', 'edge.road_class', 'edge.mean_elevation', 'edge.begin_shape_index', 'edge.end_shape_index'], action: 'include' },
    }
    try {
      // POST: a long route doesn't fit in a URL.
      const json = await up<unknown>({
        url: `${ep.valhalla}/trace_attributes`,
        method: 'POST',
        body,
        group: 'fossgis',
        priority: opts.priority ?? 'background',
        provider: 'valhalla',
        signal: opts.signal,
        cacheKey: `valhalla|trace2|${hashString(polyline6)}|${polyline6.length}`, // bump when the requested attributes change
        cacheTtlMs: CACHE_TTL_MS.route,
      })
      return normalizeTraceAttributes(json)
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw aborted()
      throw new AppError('upstream_unavailable', 'Path details are unavailable right now.', { retryable: true, provider: 'valhalla', cause: e })
    }
  }

  return { route, routeLadder, routeDetails }
}

export type { AltRouter, Router, RouteRequest, RequestOpts } from './types'
