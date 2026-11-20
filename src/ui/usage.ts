// Anonymous usage counts for the usage dashboard (/analytics; USAGE in src/config.ts, worker/usage.ts).
//
// Sent: "the app was opened"; "the app is open", once per USAGE.beatMs window while it is visible; a few
// feature uses (USAGE.events); and with a device's first open of the day, the number of days since its
// previous active day plus its city, kind of device, language and how it is used (a browser tab, the Home
// Screen web app or the iOS/Android app). No identifier,
// location or anything else that could tell devices apart: the device keeps only its last active day and
// check-in window. Nothing is sent with Do Not Track or Global Privacy Control on, from automated browsers,
// or where site storage is blocked (a device couldn't tell a new day from a repeat there).
import { useEffect } from 'react'
import { api } from '../api/client'
import type { UsageEvent, UsageFirst } from '../api/contract'
import { USAGE } from '../config'
import { currentLang } from '../i18n/useT'
import { dayKey, firstOfDay, parseUsageMemory, windowOf, type UsageMemory } from '../lib/usage'
import { useRideStore, type RideState } from '../ride/rideStore'
import { useAppStore } from '../store/appStore'
import { isNativeApp, isStandalone, platform } from './platform'

const STORAGE_KEY = 'bcycle.usage'

export function usageCountingOn(): boolean {
  if (typeof navigator === 'undefined') return false
  const n = navigator as Navigator & { globalPrivacyControl?: boolean }
  return !n.webdriver && n.globalPrivacyControl !== true && n.doNotTrack !== '1'
}

function memory(): UsageMemory | null {
  try {
    return parseUsageMemory(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return null
  }
}

function remember(m: UsageMemory): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m))
    return true
  } catch {
    return false
  }
}

/** Reports an open or a check-in; the day's first (and its gap) only once the server has it. */
function checkIn(kind: 'open' | 'beat'): void {
  const now = Date.now()
  const today = dayKey(now, USAGE.timeZone)
  const m = memory()
  // Claims the window first, so this device's other tabs skip it. No storage, no report (see above).
  if (!m || !remember({ ...m, window: windowOf(now, USAGE.beatMs) })) return
  const f = firstOfDay(m, today, USAGE.maxGapDays)
  // The apps count as installed in the app (no install tip), but for the dashboard they are the apps.
  const nativeApp = isNativeApp()
  const first: UsageFirst | null = f
    ? { gap: f.gap, systemId: useAppStore.getState().systemId, platform: platform(), installed: !nativeApp && isStandalone(), nativeApp, lang: currentLang() }
    : null
  api.usage({ kind, first }).then(
    () => {
      const latest = memory()
      if (f && latest) remember({ ...latest, day: today })
    },
    () => {}, // offline: the day's first goes with the next report
  )
}

/** Counts one use of a feature. */
export function countUse(name: UsageEvent): void {
  if (usageCountingOn()) api.usage({ kind: 'event', name }).catch(() => {})
}

const riding = (s: RideState) => s.openedParts.length > 0 || s.walkToDockOpened

/** One per page load (React's development double-run of effects must not count two). */
let opened = false

/** Test hook. */
export function resetUsageCounting(): void {
  opened = false
}

/** Mounted once (App): the open, the check-ins while the app is visible, and ride starts. */
export function useUsageCounts(): void {
  useEffect(() => {
    if (!usageCountingOn()) return
    // The open, once the city is known (a first visit picks it a moment after start).
    let stopWaiting = () => {}
    const open = () => {
      if (opened) return
      opened = true
      stopWaiting()
      checkIn('open')
    }
    if (!opened) {
      if (useAppStore.getState().systemId) open()
      else {
        const unsubscribe = useAppStore.subscribe((s) => {
          if (s.systemId) open()
        })
        const fallback = setTimeout(open, 10_000)
        stopWaiting = () => {
          unsubscribe()
          clearTimeout(fallback)
        }
      }
    }

    // While visible: a check-in at the start of each window, and on coming back to the app in a new one.
    let timer: ReturnType<typeof setTimeout> | undefined
    const beat = () => {
      if (opened && document.visibilityState === 'visible' && memory()?.window !== windowOf(Date.now(), USAGE.beatMs)) checkIn('beat')
    }
    const schedule = () => {
      clearTimeout(timer)
      const now = Date.now()
      const next = (windowOf(now, USAGE.beatMs) + 1) * USAGE.beatMs + Math.random() * USAGE.beatJitterMs
      timer = setTimeout(() => {
        beat()
        schedule()
      }, next - now)
    }
    schedule()
    document.addEventListener('visibilitychange', beat)

    // A ride starts with its first Google Maps link (or the walk to the dock, or the GPX file).
    const stopRides = useRideStore.subscribe((s, prev) => {
      if (riding(s) && !riding(prev)) countUse('ride_start')
    })

    return () => {
      stopWaiting()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', beat)
      stopRides()
    }
  }, [])
}
