// What the ride card says about alerts: what the rider needs to do on this phone and browser so "time almost
// up" and "end dock full" reach them while Google Maps is in front (Web Push), or why they can't.
import type { NotificationAccess } from '../notifications'

export type AlertsGuide =
  /** Background alerts are on for this ride. */
  | 'on'
  /** Allowed; the ride is being registered with the server. */
  | 'starting'
  /** Not asked yet: the "Turn on alerts" button and what happens next. */
  | 'ask'
  /** iPhone, in a Safari tab: alerts need the app on the Home Screen (tabs can't receive them). */
  | 'iosInstall'
  /** Installed on an iPhone older than iOS 16.4 (no web notifications). */
  | 'iosUpdate'
  /** Android browser without notifications (e.g. an in-app browser): use Chrome. */
  | 'useChrome'
  /** The rider (or the browser) blocked notifications: how to allow them again. */
  | 'blocked'
  /** Alerts show only while the app is open (no background alerts here, or they couldn't be set up). */
  | 'appOnly'

export interface AlertsGuideInput {
  platform: 'ios' | 'android' | 'desktop'
  /** Inside the iOS/Android app (Capacitor): its web view has neither web notifications nor Web Push. */
  nativeApp: boolean
  /** Running as an installed home-screen app. */
  standalone: boolean
  access: NotificationAccess
  /** The browser has the Push API and a service worker container. */
  pushSupported: boolean
  /** The server sends background alerts (it has VAPID keys); null while not known yet. */
  serverPush: boolean | null
  /** The ride's background registration (useBackgroundAlerts). */
  background: { on: boolean; failed: boolean }
}

export function alertsGuide(i: AlertsGuideInput): AlertsGuide {
  if (i.background.on) return 'on'
  // Native notifications aren't built yet, and nothing the rider can do in the app changes that: no Home Screen
  // steps, no "use Chrome", no "update iOS". Alerts show while the app is open.
  if (i.nativeApp) return 'appOnly'
  const canPush = i.serverPush === true
  // Safari tabs on iPhone have no notifications at all; only the Home Screen app does (iOS 16.4+).
  if (i.platform === 'ios' && !i.standalone) return canPush ? 'iosInstall' : 'appOnly'
  if (i.access === 'denied') return 'blocked'
  if (i.access === 'unsupported') {
    if (!canPush) return 'appOnly'
    return i.platform === 'android' ? 'useChrome' : i.platform === 'ios' ? 'iosUpdate' : 'appOnly'
  }
  if (i.access === 'default') return 'ask'
  return canPush && i.pushSupported && !i.background.failed ? 'starting' : 'appOnly'
}
