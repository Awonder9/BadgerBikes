import { describe, expect, it } from 'vitest'
import { alertsGuide, type AlertsGuideInput } from './alertsGuide'

const base: AlertsGuideInput = { platform: 'android', nativeApp: false, exactAlarms: null, standalone: false, access: 'default', pushSupported: true, serverPush: true, background: { on: false, failed: false } }
const guide = (o: Partial<AlertsGuideInput>) => alertsGuide({ ...base, ...o })

describe('what the ride card says about alerts', () => {
  it('Android Chrome: ask, then set up, then on; blocked shows how to allow again', () => {
    expect([guide({}), guide({ access: 'granted' }), guide({ access: 'granted', background: { on: true, failed: false } }), guide({ access: 'denied' })]).toEqual([
      'ask',
      'starting',
      'on',
      'blocked',
    ])
  })

  it('iPhone: a Safari tab needs the Home Screen app; the Home Screen app asks like Android', () => {
    // Safari tabs have no Notification API, so access reads "unsupported" there.
    expect(guide({ platform: 'ios', access: 'unsupported', pushSupported: false })).toBe('iosInstall')
    expect([guide({ platform: 'ios', standalone: true }), guide({ platform: 'ios', standalone: true, access: 'denied' })]).toEqual(['ask', 'blocked'])
    expect(guide({ platform: 'ios', standalone: true, access: 'unsupported', pushSupported: false })).toBe('iosUpdate') // before iOS 16.4
  })

  it('a browser without notifications on Android is pointed to Chrome', () => {
    expect(guide({ access: 'unsupported', pushSupported: false })).toBe('useChrome')
  })

  it('the iOS/Android app: ask, then the timer alerts scheduled on the phone — never Home Screen steps, Chrome or an iOS update', () => {
    // Its web view has no Web Push, whatever the server offers: the plugin's permission decides.
    for (const platform of ['ios', 'android'] as const) {
      const app = (o: Partial<AlertsGuideInput>) => guide({ nativeApp: true, platform, standalone: true, pushSupported: false, serverPush: true, ...o })
      expect([app({ access: 'default' }), app({ access: 'granted' }), app({ access: 'denied' }), app({ access: 'unsupported' })]).toEqual(['ask', 'native', 'blocked', 'appOnly'])
    }
  })

  it('the Android app with "Alarms & reminders" off: asks for it, since the timer alerts could come late', () => {
    const app = (o: Partial<AlertsGuideInput>) => guide({ nativeApp: true, standalone: true, pushSupported: false, access: 'granted', ...o })
    expect([app({ exactAlarms: false }), app({ exactAlarms: true }), app({ exactAlarms: null })]).toEqual(['exactAlarms', 'native', 'native'])
    // Not before notifications are allowed: one thing at a time.
    expect(app({ access: 'default', exactAlarms: false })).toBe('ask')
  })

  it('without background alerts on the server, never promises them (no install steps, no "use Chrome")', () => {
    for (const serverPush of [false, null]) {
      expect([
        guide({ serverPush, platform: 'ios', access: 'unsupported' }),
        guide({ serverPush, access: 'unsupported' }),
        guide({ serverPush, access: 'granted' }),
      ]).toEqual(['appOnly', 'appOnly', 'appOnly'])
      expect(guide({ serverPush })).toBe('ask') // in-app notifications still need the permission
    }
  })

  it('allowed, but set-up failed or push is missing: alerts only while the app is open', () => {
    expect([guide({ access: 'granted', background: { on: false, failed: true } }), guide({ access: 'granted', pushSupported: false })]).toEqual(['appOnly', 'appOnly'])
  })
})
