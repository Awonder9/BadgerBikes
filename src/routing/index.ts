// Router facade: Valhalla → OSRM → straight for routes, and the three bike route options.
// See ./types.ts for the rejection contract.
import { BIKE_ROUTING, CACHE_TTL_MS, ENDPOINTS } from '../config'
import { AppError, isAbort, toAppError } from '../lib/errors'
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

  /**
   * Valhalla, then OSRM: the first route found, or why each of them failed (no straight-line guess here).
   * Rejects at once when retrying elsewhere can't help: aborted, or a pin that can't reach a street.
   */
  async function fromProviders(req: RouteRequest, opts: RequestOpts): Promise<RouteLeg | AppError[]> {
    const failures: AppError[] = []
    const priority = opts.priority ?? 'interactive'
    const via = (req.via ?? []).map((v) => `${r5(v.coord)}~${v.searchCutoffMeters ?? ''}`).join(';')
    const keyTail = `${req.mode}|${req.bikeKind ?? 'classic'}|${req.useRoads ?? BIKE_ROUTING.defaultUseRoads}|${req.units}|${req.language}|${r5(req.from)}|${r5(req.to)}|${req.headingDeg ?? ''}${via ? `|via:${via}` : ''}`
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
      failures.push(toAppError(err))
    }
    // OSRM can't keep a route on our through points without stopping at them: a loop is Valhalla's or none.
    if (req.via?.length) return failures
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
      failures.push(toAppError(err))
    }
    return failures
  }

  /** A route from Valhalla, else OSRM, else a straight-line estimate (walking legs and the like). */
  async function route(req: RouteRequest, opts: RequestOpts = {}): Promise<RouteLeg> {
    const found = await fromProviders(req, opts)
    return Array.isArray(found) ? straightLeg(req) : found
  }

  /**
   * One bike route per use_roads level (at most 3), in order (identical routes are kept so options stay
   * positional; the UI marks them). A straight-line guess is useless for picking docks along the way: when both routers found no way between
   * the points this rejects with 'no_route' (trying again won't help), and when they are busy or down with
   * 'upstream_unavailable' (the rider is asked to retry shortly).
   */
  async function routeLadder(req: RouteRequest, levels: readonly number[], opts: RequestOpts = {}): Promise<RouteLeg[]> {
    const out: RouteLeg[] = []
    for (const useRoads of levels.slice(0, 3)) {
      const found = await fromProviders({ ...req, useRoads }, opts)
      if (Array.isArray(found)) {
        if (found.length > 0 && found.every((e) => e.code === 'no_route')) throw new AppError('no_route', 'No bike route between these points.', { provider: 'valhalla' })
        throw new AppError('upstream_unavailable', 'The routing server is busy. Try again in a few seconds.', { retryable: true, provider: 'valhalla' })
      }
      out.push({ ...found, useRoads })
    }
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
