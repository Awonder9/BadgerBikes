// Router facade: Valhalla → OSRM → straight for routes, and the three bike route options.
// See ./types.ts for the rejection contract.
import { BIKE_ROUTING, CACHE_TTL_MS, ENDPOINTS } from '../config'
import { AppError, isAbort } from '../lib/errors'
import type { UpstreamFetch } from '../lib/upstream'
import type { LngLat, RouteLeg } from '../types'
import { mapOsrmError, normalizeOsrmRoute, osrmRouteUrl } from './osrm'
import { straightLeg } from './straight'
import type { AltRouter, RequestOpts, RouteRequest } from './types'
import { mapValhallaError, normalizeValhallaRoute, routeBody, valhallaUrl } from './valhalla'

export interface RouterDeps {
  upstream: UpstreamFetch
  endpoints?: Pick<typeof ENDPOINTS, 'valhalla' | 'osrmBike' | 'osrmFoot'>
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

  return { route, routeLadder }
}

export type { AltRouter, Router, RouteRequest, RequestOpts } from './types'
