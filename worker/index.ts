// Cloudflare Worker entry: wires real dependencies into the API app. Static assets are served by
// Cloudflare before the Worker runs (wrangler.jsonc: run_worker_first only for /api/*).
import { fetchStationsSnapshot, fetchSystemDetails } from '../src/data/gbfs'
import { reversePlace, searchPlaces } from '../src/geocode/photon'
import { createRouter } from '../src/routing'
import { createApp } from './app'
import { createUpstream } from './upstream'

export { UpstreamGate } from './gate'

export default {
  async fetch(request, env, ctx): Promise<Response> {
    void ctx
    const upstream = createUpstream({
      gateFor: (group) => {
        try {
          return env.UPSTREAM_GATE.get(env.UPSTREAM_GATE.idFromName(group))
        } catch {
          return null
        }
      },
      contactEmail: env.CONTACT_EMAIL || null,
      cache: typeof caches !== 'undefined' ? caches.default : null,
    })
    const app = createApp({
      upstream,
      createRouter,
      fetchStationsSnapshot,
      fetchSystemDetails,
      searchPlaces,
      reversePlace,
      now: () => Date.now(),
      contactEmail: env.CONTACT_EMAIL || null,
      version: env.APP_VERSION,
      limiters: { route: env.ROUTE_LIMITER, geocode: env.GEOCODE_LIMITER },
    })
    return app.fetch(request)
  },
} satisfies ExportedHandler<Env>
