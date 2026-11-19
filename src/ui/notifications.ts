// Notification permission as a value components can subscribe to: the "Turn on alerts" button and the
// background ride alerts both depend on it, and the browser fires no event when it changes after a prompt.
import { useSyncExternalStore } from 'react'

export type NotificationAccess = NotificationPermission | 'unsupported'

const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
let watchingSettings = false

export function notificationAccess(): NotificationAccess {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Also follow changes made in the browser's site settings, where the Permissions API reports them.
  if (!watchingSettings && typeof navigator !== 'undefined' && navigator.permissions?.query) {
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

/** Asks for permission (call from a tap) and tells every subscriber the answer. */
export async function requestNotificationAccess(): Promise<NotificationAccess> {
  if (typeof Notification === 'undefined') return 'unsupported'
  const answer = await Notification.requestPermission()
  changed()
  return answer
}
