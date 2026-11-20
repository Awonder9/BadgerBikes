// Notification permission as a value components can subscribe to: the "Turn on alerts" button and the
// background ride alerts both depend on it, and the browser fires no event when it changes after a prompt.
// Inside the iOS/Android apps it comes from the local notifications plugin (src/native/notifications.ts).
import { useSyncExternalStore } from 'react'
import { notificationState, openExactAlarmSetting, requestNotifications } from '../native/notifications'
import { isNativeApp } from './platform'

export type NotificationAccess = NotificationPermission | 'unsupported'

const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
let watchingSettings = false

/** The apps' answers, as last read from the plugin ("default" until then; "unsupported" if it can't load). */
let native: { access: NotificationAccess; exactAlarms: boolean | null } = { access: 'default', exactAlarms: null }
const setNative = (next: typeof native) => {
  if (next.access === native.access && next.exactAlarms === native.exactAlarms) return
  native = next
  changed()
}
const refreshNative = () =>
  notificationState()
    .then(setNative)
    .catch(() => setNative({ access: 'unsupported', exactAlarms: null }))

export function notificationAccess(): NotificationAccess {
  if (isNativeApp()) return native.access
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** Android app: whether alerts can be scheduled on time ("Alarms & reminders"); null elsewhere or not known yet. */
export function exactAlarmAccess(): boolean | null {
  return isNativeApp() ? native.exactAlarms : null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!watchingSettings && isNativeApp()) {
    watchingSettings = true
    void refreshNative()
    // Back from the phone's settings: read the answers again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshNative()
    })
  } else if (!watchingSettings && typeof navigator !== 'undefined' && navigator.permissions?.query) {
    // Also follow changes made in the browser's site settings, where the Permissions API reports them.
    watchingSettings = true
    navigator.permissions
      .query({ name: 'notifications' })
      .then((status) => status.addEventListener('change', changed))
      .catch(() => {})
  }
  return () => listeners.delete(listener)
}

export function useNotificationAccess(): NotificationAccess {
  return useSyncExternalStore(subscribe, notificationAccess, () => 'unsupported')
}

export function useExactAlarmAccess(): boolean | null {
  return useSyncExternalStore(subscribe, exactAlarmAccess, () => null)
}

/** Asks for permission (call from a tap) and tells every subscriber the answer. */
export async function requestNotificationAccess(): Promise<NotificationAccess> {
  if (isNativeApp()) {
    await requestNotifications().then(setNative, refreshNative)
    return native.access
  }
  if (typeof Notification === 'undefined') return 'unsupported'
  const answer = await Notification.requestPermission()
  changed()
  return answer
}

/** Android app: opens the "Alarms & reminders" setting (call from a tap), then reads the answer. */
export async function requestExactAlarms(): Promise<void> {
  await openExactAlarmSetting().catch(() => {})
  await refreshNative()
}
