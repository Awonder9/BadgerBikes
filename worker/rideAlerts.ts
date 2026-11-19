// RideAlerts Durable Object: one instance per push subscription (idFromName of the endpoint's hash) holds that
// device's ride and wakes up on alarms to send its background alerts: the ride timer's "almost up" / "past
// your included time" at their moments, and "end dock full" from a check every PUSH.dockCheckMs. The rules
// live in worker/rideAlertsCore.ts; this class only stores the state, checks the dock and sends.
//
// Stored: the push subscription, language, city, end dock, party size and ride timer — no location. It is
// deleted when the ride ends (POST /api/push/cancel), when the push service says the subscription is gone,
// and at the latest PUSH.maxRideMs after the ride started.
import { DurableObject } from 'cloudflare:workers'
import type { PushRideRequest } from '../src/api/contract'
import { fetchStationsSnapshot } from '../src/data/gbfs'
import { postBytes } from '../src/lib/http'
import { endDockState, type EndDockState } from '../src/ride/rideProgress'
import { alertMessage, dueAlerts, markSent, nextWakeMs, planRide, type AlertKind, type RideAlertState } from './rideAlertsCore'
import { createUpstream } from './upstream'
import { USAGE_OBJECT } from './usage'
import { pushRequest, vapidKeysFrom } from './webPush'

const KEY = 'ride'

/** Worker secrets for background alerts (optional: without them the feature is off). */
export type PushSecrets = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string }

/** The SHA-256 of a push endpoint, hex: the Durable Object name for that device (the endpoint itself is a secret URL). */
export async function endpointKey(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export class RideAlerts extends DurableObject<Env> {
  /** Replaces this device's ride (keeping what was already sent if it is the same ride). */
  async schedule(req: PushRideRequest): Promise<void> {
    const now = Date.now()
    const prev = (await this.ctx.storage.get<RideAlertState>(KEY)) ?? null
    const state = planRide(req, now, prev)
    await this.ctx.storage.put(KEY, state)
    await this.wake(state, now)
  }

  /** The ride ended: forget it. */
  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RideAlertState>(KEY)
    if (!state) return
    const now = Date.now()
    if (now >= state.expiresAtMs) return this.cancel()
    const dock = await this.endDock(state)
    for (const kind of dueAlerts(state, now, dock?.state ?? null)) {
      const result = await this.send(state, kind, now, dock?.name ?? null)
      if (result === 'gone') return this.cancel()
      if (result === 'sent') {
        markSent(state, kind)
        await this.countSent()
      }
    }
    await this.ctx.storage.put(KEY, state)
    await this.wake(state, now)
  }

  private async wake(state: RideAlertState, now: number): Promise<void> {
    const next = nextWakeMs(state, now)
    if (next === null) await this.cancel()
    else await this.ctx.storage.setAlarm(next)
  }

  /** The end dock's state from the live feed (cached like every GBFS read); null when not watched or unknown. */
  private async endDock(state: RideAlertState): Promise<{ state: EndDockState; name: string } | null> {
    if (!state.endStationId || state.sent.full) return null
    try {
      const upstream = createUpstream({
        gateFor: () => null,
        contactEmail: this.env.CONTACT_EMAIL || null,
        cache: typeof caches !== 'undefined' ? caches.default : null,
        waitUntil: (work) => this.ctx.waitUntil(work),
      })
      const station = (await fetchStationsSnapshot(state.systemId, upstream)).byId.get(state.endStationId)
      return station ? { state: endDockState(station, state.partySize), name: station.name } : null
    } catch {
      return null // the feed is unreachable: check again next time
    }
  }

  /** For the usage dashboard: an alert reached a rider. Never holds up the alerts. */
  private async countSent(): Promise<void> {
    try {
      await this.env.USAGE.get(this.env.USAGE.idFromName(USAGE_OBJECT)).count('alerts_sent')
    } catch {
      /* best effort */
    }
  }

  private async send(state: RideAlertState, kind: AlertKind, now: number, stationName: string | null): Promise<'sent' | 'gone' | 'retry'> {
    const keys = vapidKeysFrom(this.env as Env & PushSecrets)
    if (!keys) return 'gone' // background alerts were switched off on this server
    try {
      const message = alertMessage(kind, state, now, stationName)
      const req = await pushRequest(state, JSON.stringify(message), keys, { nowSeconds: Math.floor(now / 1000), urgency: 'high', topic: message.tag })
      const { status } = await postBytes(req.url, req.body, { headers: req.headers, provider: 'push' })
      // 404/410: the browser unsubscribed or the subscription expired. Other failures are retried.
      if (status === 404 || status === 410) return 'gone'
      return status >= 200 && status < 300 ? 'sent' : 'retry'
    } catch {
      return 'retry'
    }
  }
}
