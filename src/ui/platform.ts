// The rider's device, for platform-specific hand-offs (app store links, install steps, background alerts).
import { NATIVE_APP } from '../config'

export function platform(): 'ios' | 'android' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

/**
 * Inside the iOS/Android app (Capacitor). Its native bridge defines `window.Capacitor` before the page's scripts
 * run, so this needs no import of @capacitor/core (which would add it to the web app's bundle).
 */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}

/**
 * Running as an installed app: from the home screen (on iPhone, only then can web apps receive push alerts), or
 * the iOS/Android app. Either way there is nothing left to install.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return isNativeApp() || window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** Where share links point: this page's origin in the web app; the deployed site from the native apps (their page is on the phone). */
export function shareOrigin(): string {
  return NATIVE_APP.webOrigin || window.location.origin
}
