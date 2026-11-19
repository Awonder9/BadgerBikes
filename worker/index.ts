// Cloudflare Worker entry: wires real dependencies into the API app. Static assets are served by
// Cloudflare before the Worker runs (wrangler.jsonc: run_worker_first only for /api/*).
import { fetchStationsSnapshot, fetchSystemDetails } from '../src/data/gbfs'
import { reversePlace, searchPlaces } from '../src/geocode/photon'
import { createRouter } from '../src/routing'
import { createApp } from './app'
import { endpointKey, type PushSecrets } from './rideAlerts'
import { createUpstream } from './upstream'
import { USAGE_OBJECT } from './usage'
import { vapidKeysFrom } from './webPush'

export { UpstreamGate } from './gate'
export { RideAlerts } from './rideAlerts'
export { Usage } from './usage'

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Background ride alerts only when this deployment has VAPID keys (`npm run vapid-keys`).
    const vapid = vapidKeysFrom(env as Env & PushSecrets)
    const upstream = createUpstream({
      // Cache writes and gate releases finish after the response is sent.
      waitUntil: (work) => ctx.waitUntil(work),
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
    const usage = () => env.USAGE.get(env.USAGE.idFromName(USAGE_OBJECT))
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
      limiters: { route: env.ROUTE_LIMITER, geocode: env.GEOCODE_LIMITER, push: env.PUSH_LIMITER, usage: env.USAGE_LIMITER },
      push: vapid
        ? { publicKey: vapid.publicKey, rideAlerts: async (endpoint) => env.RIDE_ALERTS.get(env.RIDE_ALERTS.idFromName(await endpointKey(endpoint))) }
        : null,
      usage: { record: (req) => usage().record(req), count: (name) => usage().count(name), report: (days) => usage().report(days) },
      background: (work) => ctx.waitUntil(work),
    })
    return app.fetch(request)
  },
} satisfies ExportedHandler<Env>
