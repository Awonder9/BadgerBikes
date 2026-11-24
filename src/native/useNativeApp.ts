// The iOS/Android apps' wiring, mounted once (App): share links that open the app (Universal Links, App Links)
// and Android's back button. Does nothing in the web app.
import { useEffect } from 'react'
import { NATIVE_APP } from '../config'
import { SYSTEM_IDS } from '../data/systems'
import { safeStorage } from '../lib/storage'
import { parseLaunchParams } from '../lib/urlParams'
import { useAppStore } from '../store/appStore'
import { openLaunchParams } from '../ui/launchParams'
import { openStravaReturn } from '../ui/rides/stravaReturn'
import { goBack } from '../ui/layout/backButton'
import { isNativeApp, platform } from '../ui/platform'
import { appLinkSearch, shouldOpenLink, type OpenedLink } from './appLinks'
import { nativePlugins } from '.'

const LAST_LINK_KEY = 'bcycle.lastAppLink'

function openLink(url: string, via: 'launch' | 'event'): void {
  const search = appLinkSearch(url, NATIVE_APP.webOrigin)
  if (search === null) return
  const session = safeStorage('session')
  let last: OpenedLink | null = null
  try {
    last = JSON.parse(session.getItem(LAST_LINK_KEY) ?? 'null') as OpenedLink | null
  } catch {
    last = null
  }
  const now = Date.now()
  if (!shouldOpenLink(url, via, last, now)) return
  session.setItem(LAST_LINK_KEY, JSON.stringify({ url, atMs: now } satisfies OpenedLink))
  if (openStravaReturn(search)) return
  openLaunchParams(parseLaunchParams(search, SYSTEM_IDS))
}

/** Back: first leaves a text field (closing its suggestions), then closes panels; at the top the app goes to the background. */
function back(toBackground: () => void): void {
  const focused = document.activeElement
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return focused.blur()
  if (!goBack(useAppStore.getState())) toBackground()
}

interface Handle {
  remove: () => Promise<void>
}

export function useNativeApp(): void {
  useEffect(() => {
    if (!isNativeApp()) return
    let stopped = false
    const handles: Handle[] = []
    const keep = (h: Handle) => {
      if (stopped) void h.remove()
      else handles.push(h)
    }
    void nativePlugins()
      .then(async ({ App }) => {
        if (stopped) return
        // A link that launched the app is delivered to the first listener too (iPhone); see appLinks.ts.
        keep(await App.addListener('appUrlOpen', ({ url }) => openLink(url, 'event')))
        if (platform() === 'android') keep(await App.addListener('backButton', () => back(() => void App.minimizeApp())))
        const launch = await App.getLaunchUrl()
        if (!stopped && launch?.url) openLink(launch.url, 'launch')
      })
      .catch(() => {})
    return () => {
      stopped = true
      for (const h of handles.splice(0)) void h.remove()
    }
  }, [])
}
