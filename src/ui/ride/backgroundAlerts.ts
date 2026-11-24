// Background ride alerts (Web Push). A web page can't run while Google Maps is in front, so while a ride is
// under way and notifications are allowed, the Worker is told the ride's timer and end dock and pushes "time
// almost up", "past your included time" and "end dock full" itself (worker/rideAlerts.ts). Best effort:
// without push support (on iPhone: until the app is on the Home Screen), a service worker or a server key,
// the in-app alerts still work while the app is open.
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../api/client'
import type { PushRideRequest, PushSubscriptionJson } from '../../api/contract'
import { useMeta, useSystemDetails } from '../../data/hooks'
import { useLang } from '../../i18n/useT'
import { base64urlToBytes } from '../../lib/base64url'
import { RIDE } from '../../config'
import { loopsBack, useRideStore, rideActive } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { useNotificationAccess } from '../notifications'
import { countUse } from '../usage'
import type { RidePlan } from './useRidePlan'

/**
 * The ride under way's background alerts, for the ride card: `on` once the server has the ride (alerts reach
 * the rider while Google Maps is in front); `failed` when that couldn't be set up (only in-app alerts).
 */
export const useBackgroundAlerts = create<{ on: boolean; failed: boolean }>(() => ({ on: false, failed: false }))

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator && typeof Notification !== 'undefined'
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/** This device's push subscription for the server's key: the existing one, or a new one (renewed after a key change). */
async function subscription(publicKey: string): Promise<PushSubscriptionJson | null> {
  const key = base64urlToBytes(publicKey)
  const reg = await navigator.serviceWorker.getRegistration()
  if (!key || !reg) return null // no service worker (e.g. the dev server)
  let sub = await reg.pushManager.getSubscription()
  const subKey = sub?.options.applicationServerKey
  if (sub && !(subKey && sameBytes(new Uint8Array(subKey), key))) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const json = sub.toJSON()
  return json.endpoint && json.keys?.p256dh && json.keys.auth ? { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } : null
}

/**
 * Every registration and cancel of this device goes out in order, one after another: the server keeps whatever
 * arrives last, so an older ride (or a registration still on its way when the ride ended) can't win.
 */
let queue: Promise<unknown> = Promise.resolve()
function inOrder(task: () => Promise<unknown>): void {
  queue = queue.then(task).catch(() => {})
}

/** The endpoint of this device's push subscription, if it has one (nothing is subscribed or asked for here). */
async function existingEndpoint(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null
}

/**
 * Stops the device's alerts (`endpoint`, or the device's own subscription's when this page never registered the
 * ride); if offline, tries again once the connection is back (a stale alert is worse than none).
 */
function cancel(endpoint: string | null): void {
  inOrder(async () => {
    const target = endpoint ?? (await existingEndpoint().catch(() => null))
    if (!target) return
    await api.pushCancel(target).catch(() => window.addEventListener('online', () => inOrder(() => api.pushCancel(target)), { once: true }))
  })
}

/** Mounted once (AppShell): keeps the Worker's copy of the ride in step with the plan, and ends it with the ride. */
export function useBackgroundRideAlerts(plan: RidePlan): void {
  const { systemId, partySize, pass } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize, pass: s.systemId ? s.settings.passBySystem[s.systemId] : undefined })),
  )
  const { active, startedAt, roundTrip } = useRideStore(useShallow((s) => ({ active: rideActive(s), startedAt: s.rideStartedAtMs, roundTrip: loopsBack(s) })))
  const lang = useLang()
  const allowed = useNotificationAccess() === 'granted' && pushSupported()
  const publicKey = useMeta(active && allowed)?.pushPublicKey ?? null
  // Register only once the plan is known: the stations loaded (so the end dock is) and the pass's minutes
  // known (chosen, or the system's details loaded or failed). A first registration made from a half-loaded
  // plan right after a reload would make the server forget which alerts it already sent.
  const details = useSystemDetails(systemId, active && !pass)
  const planKnown = !!plan.start && (!!pass || details.details !== undefined || details.error !== null)
  // A loop just started from its own end dock: the server watches that dock only once the live feed has had time to
  // show the bikes the party took from it (RIDE.loopEndWatchDelayMs), or its first check would read "full".
  // (A page reloaded later in such a ride starts out watching it: its first registration then names the dock already.)
  const [watchFrom, setWatchFrom] = useState<number | null>(() => {
    const s = useRideStore.getState()
    return s.rideStartedAtMs !== null && Date.now() - s.rideStartedAtMs >= RIDE.loopEndWatchDelayMs ? s.rideStartedAtMs : null
  })
  useEffect(() => {
    if (!roundTrip || startedAt === null) return
    const id = setTimeout(() => setWatchFrom(startedAt), Math.max(0, startedAt + RIDE.loopEndWatchDelayMs - Date.now()))
    return () => clearTimeout(id)
  }, [roundTrip, startedAt])
  const endStationId = roundTrip && watchFrom !== startedAt ? null : (plan.end?.station.id ?? null)
  const { includedMinutes } = plan
  // Everything the alerts depend on; registering again with the same ride repeats no alert (the server keeps
  // what it already sent), so a re-render or a reload never double-notifies.
  const ride = useMemo<Omit<PushRideRequest, 'subscription'> | null>(
    () => (active && allowed && planKnown && publicKey && systemId ? { lang, systemId, endStationId, partySize, rideStartedAtMs: startedAt, includedMinutes } : null),
    [active, allowed, planKnown, publicKey, systemId, lang, endStationId, partySize, startedAt, includedMinutes],
  )
  const registered = useRef<string | null>(null)

  useEffect(() => {
    if (!ride || !publicKey) return
    let stale = false
    inOrder(async () => {
      if (stale) return // superseded before its turn (a newer ride is queued, or the ride ended)
      try {
        const sub = await subscription(publicKey)
        if (stale) return
        if (!sub) return useBackgroundAlerts.setState({ on: false, failed: true }) // no service worker
        registered.current = sub.endpoint
        await api.pushRide({ ...ride, subscription: sub })
        if (stale) return
        if (!useBackgroundAlerts.getState().on) countUse('alerts_on') // once per ride, not per update
        useBackgroundAlerts.setState({ on: true, failed: false })
      } catch {
        if (!stale) useBackgroundAlerts.setState({ on: false, failed: true })
      }
    })
    return () => {
      stale = true
    }
  }, [ride, publicKey])

  // The ride ended (End ride, arrived, plan cleared): no more background alerts. Queued after any
  // registration still on its way, so it is the last word. A ride registered before a reload, and ended before this
  // page registered it again (stations still loading, or offline), is cancelled through the device's own
  // subscription: the server would otherwise keep alerting for it.
  const wasActive = useRef(false)
  useEffect(() => {
    if (active) {
      wasActive.current = true
      return
    }
    const endpoint = registered.current
    const ended = wasActive.current
    registered.current = null
    wasActive.current = false
    useBackgroundAlerts.setState({ on: false, failed: false })
    if (endpoint) cancel(endpoint)
    else if (ended && pushSupported()) cancel(null)
  }, [active])
}
