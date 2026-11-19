import { describe, expect, it } from 'vitest'
import { appLaunchUrl, buildRideShareUrl, buildStationShareUrl, parseLatLon, parseLaunchParams, safeAppDiscoveryUri, safeExternalUrl, stripLaunchParams } from './urlParams'

const KNOWN = new Set(['bcycle_madison', 'bcycle_indego'])

describe('parseLaunchParams', () => {
  it('accepts only registry system ids', () => {
    expect(parseLaunchParams('?system=bcycle_madison', KNOWN).systemId).toBe('bcycle_madison')
    expect(parseLaunchParams('?system=../../evil', KNOWN).systemId).toBeNull()
    expect(parseLaunchParams('', KNOWN)).toMatchObject({ systemId: null, rideStartId: null, to: null, routeIndex: null })
  })

  it('parses ids, shared points and the route option defensively', () => {
    const p = parseLaunchParams('?station=bcycle_madison_1874&start=x%20y&to=43.07652,-89.4003&toName=<b>Memorial%20Union</b>&route=2', KNOWN)
    expect(p.stationId).toBe('bcycle_madison_1874')
    expect(p.to).toEqual({ coord: [-89.4003, 43.07652], name: 'bMemorial Union/b' })
    expect(p.rideStartId).toBeNull() // space not allowed in ids
    expect(p.routeIndex).toBe(2)
    expect(parseLaunchParams('?route=7', KNOWN).routeIndex).toBeNull()
  })

  it('rejects out-of-range or malformed coordinates', () => {
    expect(parseLatLon('43.07,-89.40')).toEqual([-89.4, 43.07])
    expect(parseLatLon('95,10')).toBeNull()
    expect(parseLatLon('43.07')).toBeNull()
    expect(parseLatLon('javascript:alert(1)')).toBeNull()
  })

  it('round-trips ride share links', () => {
    const url = buildRideShareUrl('https://bcycle.example', {
      systemId: 'bcycle_madison',
      startId: 'bcycle_madison_1874',
      to: { coord: [-89.4003, 43.07652], name: 'Memorial Union & Terrace' },
      toStationId: 'bcycle_madison_1888',
      routeIndex: 1,
    })
    const parsed = parseLaunchParams(new URL(url).search, KNOWN)
    expect(parsed).toMatchObject({ systemId: 'bcycle_madison', rideStartId: 'bcycle_madison_1874', toStationId: 'bcycle_madison_1888', routeIndex: 1 })
    expect(parsed.to).toEqual({ coord: [-89.4003, 43.07652], name: 'Memorial Union & Terrace' })
    expect(stripLaunchParams(url + '#x')).toBe('/#x')
  })

  it('round-trips station share links', () => {
    const url = buildStationShareUrl('https://bcycle.example', 'bcycle_madison', 'bcycle_madison_1874')
    expect(url).toBe('https://bcycle.example/?system=bcycle_madison&station=bcycle_madison_1874')
    expect(parseLaunchParams(new URL(url).search, KNOWN)).toMatchObject({ systemId: 'bcycle_madison', stationId: 'bcycle_madison_1874', rideStartId: null })
  })
})

describe('safeExternalUrl', () => {
  it('allows https on allowed hosts and subdomains only', () => {
    expect(safeExternalUrl('https://www.bcycle.com/applink?x=1', ['bcycle.com'])).toBe('https://www.bcycle.com/applink?x=1')
    expect(safeExternalUrl('https://evilbcycle.com/', ['bcycle.com'])).toBeNull()
    expect(safeExternalUrl('http://www.bcycle.com/', ['bcycle.com'])).toBeNull()
    expect(safeExternalUrl('javascript:alert(1)', null)).toBeNull()
    expect(safeExternalUrl('https://user:pw@bcycle.com/', ['bcycle.com'])).toBeNull()
    expect(safeExternalUrl('https://madison.bcycle.com', null)).toBe('https://madison.bcycle.com/')
    expect(safeExternalUrl('not a url', null)).toBeNull()
  })

  it('only accepts the bcycle:// discovery scheme', () => {
    expect(safeAppDiscoveryUri('bcycle://')).toBe('bcycle://')
    expect(safeAppDiscoveryUri('intent://evil')).toBeNull()
    expect(safeAppDiscoveryUri('bcycle://x"onload')).toBeNull()
  })
})

describe('appLaunchUrl', () => {
  const play = 'https://play.google.com/store/apps/details?id=com.bcycle'
  it('opens the App Store page on iOS and an intent link with a store fallback on Android', () => {
    expect(appLaunchUrl('ios', 'bcycle://', 'https://apps.apple.com/us/app/bcycle/id371185597')).toBe('itms-apps://apps.apple.com/app/id371185597')
    expect(appLaunchUrl('ios', 'bcycle://', 'https://evil.example/app/id371185597')).toBeNull()
    expect(appLaunchUrl('android', 'bcycle://', play)).toBe(`intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.bcycle;S.browser_fallback_url=${encodeURIComponent(play)};end`)
  })
  it('refuses unknown schemes and odd package ids', () => {
    expect(appLaunchUrl('android', 'javascript:alert(1)', null)).toBeNull()
    expect(appLaunchUrl('android', 'bcycle://', 'https://play.google.com/store/apps/details?id=evil;end')).toBe('bcycle://')
    expect(appLaunchUrl('android', 'bcycle://', null)).toBe('bcycle://')
  })
})
