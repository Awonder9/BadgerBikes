// Background ride alerts (Web Push). A web page can't run while Google Maps is in front, so while a ride is
// under way and notifications are allowed, the Worker is told the ride's timer and end dock and pushes "time
// almost up", "past your included time" and "end dock full" itself (worker/rideAlerts.ts). Best effort:
// without push support (on iPhone: until the app is on the Home Screen), a service worker or a server key,
// the in-app alerts still work while the app is open.
import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../api/client'
import type { PushRideRequest, PushSubscriptionJson } from '../../api/contract'
import { useMeta, useSystemDetails } from '../../data/hooks'
import { useLang } from '../../i18n/useT'
import { base64urlToBytes } from '../../lib/base64url'
import { useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { useNotificationAccess } from '../notifications'
import type { RidePlan } from './useRidePlan'

/** Whether the alerts of the ride under way also reach the rider in the background (the ride card says so). */
export const useBackgroundAlerts = create<{ on: boolean }>(() => ({ on: false }))

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

/** Stops the device's alerts; if offline, tries again once the connection is back (a stale alert is worse than none). */
function cancel(endpoint: string): void {
  inOrder(() => api.pushCancel(endpoint).catch(() => window.addEventListener('online', () => inOrder(() => api.pushCancel(endpoint)), { once: true })))
}

/** Mounted once (AppShell): keeps the Worker's copy of the ride in step with the plan, and ends it with the ride. */
export function useBackgroundRideAlerts(plan: RidePlan): void {
  const { systemId, partySize, pass } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize, pass: s.systemId ? s.settings.passBySystem[s.systemId] : undefined })),
  )
  const { active, startedAt } = useRideStore(useShallow((s) => ({ active: s.openedParts.length > 0 || s.walkToDockOpened, startedAt: s.rideStartedAtMs })))
  const lang = useLang()
  const allowed = useNotificationAccess() === 'granted' && pushSupported()
  const publicKey = useMeta(active && allowed)?.pushPublicKey ?? null
  // Register only once the plan is known: the stations loaded (so the end dock is) and the pass's minutes
  // known (chosen, or the system's details loaded or failed). A first registration made from a half-loaded
  // plan right after a reload would make the server forget which alerts it already sent.
  const details = useSystemDetails(systemId, active && !pass)
  const planKnown = !!plan.start && (!!pass || details.details !== undefined || details.error !== null)
  const endStationId = plan.end?.station.id ?? null
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
        if (!sub || stale) return
        registered.current = sub.endpoint
        await api.pushRide({ ...ride, subscription: sub })
        if (!stale) useBackgroundAlerts.setState({ on: true })
      } catch {
        if (!stale) useBackgroundAlerts.setState({ on: false })
      }
    })
    return () => {
      stale = true
    }
  }, [ride, publicKey])

  // The ride ended (End ride, arrived, plan cleared): no more background alerts. Queued after any
  // registration still on its way, so it is the last word.
  useEffect(() => {
    if (active) return
    const endpoint = registered.current
    registered.current = null
    useBackgroundAlerts.setState({ on: false })
    if (endpoint) cancel(endpoint)
  }, [active])
}
