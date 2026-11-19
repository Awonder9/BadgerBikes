// Asks the service worker registration to look for a newly deployed version while the app stays open.
// Without this the browser only checks on a page load, and an installed app on iPhone is resumed from the
// background rather than reloaded — so riders never saw "Update available" until they force-quit the app.
import { POLL } from '../../config'

/** The part of ServiceWorkerRegistration used here (injectable for tests). */
export interface UpdatableRegistration {
  installing: unknown
  update(): Promise<unknown>
}

export interface UpdateCheckEnv {
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>
  isOnline: () => boolean
  now: () => number
}

/** Starts checking; returns a function that stops. */
export function startAppUpdateChecks(registration: UpdatableRegistration, env: UpdateCheckEnv): () => void {
  let lastCheck = env.now()
  const check = (force: boolean) => {
    if (env.document.visibilityState !== 'visible' || !env.isOnline() || registration.installing) return
    const now = env.now()
    if (!force && now - lastCheck < POLL.appUpdateMinGapMs) return
    lastCheck = now
    // Offline, server hiccup, or the worker script failed to parse: try again on the next occasion.
    registration.update().catch(() => {})
  }
  const onForeground = () => check(false)
  const onVisibility = () => {
    if (env.document.visibilityState === 'visible') check(false)
  }
  env.document.addEventListener('visibilitychange', onVisibility)
  env.window.addEventListener('pageshow', onForeground)
  env.window.addEventListener('focus', onForeground)
  env.window.addEventListener('online', onForeground)
  const timer = env.window.setInterval(() => check(true), POLL.appUpdateCheckMs)
  return () => {
    env.document.removeEventListener('visibilitychange', onVisibility)
    env.window.removeEventListener('pageshow', onForeground)
    env.window.removeEventListener('focus', onForeground)
    env.window.removeEventListener('online', onForeground)
    env.window.clearInterval(timer)
  }
}
