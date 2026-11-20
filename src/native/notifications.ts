// Notifications inside the iOS/Android apps (local notifications plugin): permission, Android's exact-alarm
// setting, the ride timer's alerts scheduled on the phone, and alerts shown right away. The apps' web views have
// neither web notifications nor Web Push.
import { NATIVE_ALERT_IDS, type AlertKind, type TimedAlert } from '../ride/rideProgress'
import { platform } from '../ui/platform'
import { nativePlugins } from '.'

export type NativeAccess = 'granted' | 'denied' | 'default'

export interface NativeNotificationState {
  access: NativeAccess
  /**
   * Android: whether alarms may be exact ("Alarms & reminders", off by default since Android 14). Without it a
   * scheduled alert can come many minutes late. null on iPhone, whose scheduled notifications are always on time.
   */
  exactAlarms: boolean | null
}

/** The Android notification channel of the ride alerts (shown in the system settings under its name). */
const CHANNEL_ID = 'ride-alerts'

const asAccess = (display: string): NativeAccess => (display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'default')

async function exactAlarms(): Promise<boolean | null> {
  if (platform() !== 'android') return null
  const { LocalNotifications } = await nativePlugins()
  return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted'
}

export async function notificationState(): Promise<NativeNotificationState> {
  const { LocalNotifications } = await nativePlugins()
  const { display } = await LocalNotifications.checkPermissions()
  return { access: asAccess(display), exactAlarms: await exactAlarms().catch(() => null) }
}

/** Asks for permission (iPhone, Android 13+), then reports the answer. */
export async function requestNotifications(): Promise<NativeNotificationState> {
  const { LocalNotifications } = await nativePlugins()
  const { display } = await LocalNotifications.requestPermissions()
  return { access: asAccess(display), exactAlarms: await exactAlarms().catch(() => null) }
}

/** Android: opens this app's "Alarms & reminders" setting; resolves once the rider is back. */
export async function openExactAlarmSetting(): Promise<void> {
  const { LocalNotifications } = await nativePlugins()
  await LocalNotifications.changeExactNotificationSetting()
}

/** Plugin calls one after another, so a cancel can't overtake the schedule it replaces. */
let queue: Promise<unknown> = Promise.resolve()
function inOrder(task: () => Promise<unknown>): void {
  queue = queue.then(task).catch(() => {})
}

let channelName: string | null = null
/**
 * Android: the ride alerts' channel, high importance so they pop up over Google Maps (renamed with the language).
 * Android 7 has no channels: the plugin answers "unavailable" there, and its notifications need none.
 */
async function ensureChannel(name: string): Promise<void> {
  if (platform() !== 'android' || channelName === name) return
  const { LocalNotifications } = await nativePlugins()
  await LocalNotifications.createChannel({ id: CHANNEL_ID, name, importance: 4, visibility: 1, vibration: true }).catch(() => {})
  channelName = name
}

/**
 * Replaces the ride timer's scheduled alerts with these; none cancels them (the ride ended). `exactAllowed`:
 * Android's "Alarms & reminders" as last read (null: not known yet, so the plugin is asked).
 */
export function scheduleTimerAlerts(alerts: readonly TimedAlert[], channel: string, exactAllowed: boolean | null): void {
  inOrder(async () => {
    const { LocalNotifications } = await nativePlugins()
    await LocalNotifications.cancel({ notifications: [{ id: NATIVE_ALERT_IDS.warn }, { id: NATIVE_ALERT_IDS.over }] })
    if (alerts.length === 0) return
    await ensureChannel(channel)
    // Exact only when allowed: asked for otherwise, the plugin would open the "Alarms & reminders" screen in the
    // middle of a ride. Without it the alert is inexact, and the ride card says how to turn it on. (Android
    // restarts the app when the setting is turned off, so a remembered "allowed" is never stale.)
    const exact = (exactAllowed ?? (await exactAlarms().catch(() => null))) !== false
    await LocalNotifications.schedule({
      notifications: alerts.map((a) => ({
        id: NATIVE_ALERT_IDS[a.kind],
        title: a.title,
        body: a.body,
        channelId: CHANNEL_ID,
        schedule: { at: new Date(a.atMs), allowWhileIdle: true },
        isExactNotification: exact,
      })),
    })
  })
}

/** Shows an alert right away (the end dock filled up while the app is open); it replaces the last one of its kind. */
export function showAlertNow(kind: AlertKind, title: string, body: string, channel: string): void {
  inOrder(async () => {
    const { LocalNotifications } = await nativePlugins()
    await ensureChannel(channel)
    await LocalNotifications.schedule({ notifications: [{ id: NATIVE_ALERT_IDS[kind], title, body, channelId: CHANNEL_ID, isExactNotification: false }] })
  })
}
