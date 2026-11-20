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

  it('writes place names without whitespace, so the link can’t break at a space', () => {
    const share = (name: string) => buildRideShareUrl('https://bcycle.example', { systemId: 'bcycle_madison', startId: 's1', to: { coord: [-89.4153, 43.0418], name } })
    const url = share('UW Arboretum\u00a0Visitor  Center (Gallistel)')
    expect(url).toBe('https://bcycle.example/?system=bcycle_madison&start=s1&toName=UW_Arboretum_Visitor_Center_%28Gallistel%29&to=43.041800%2C-89.415300')
    expect(url).not.toMatch(/[\s+]/)
    expect(parseLaunchParams(new URL(url).search, KNOWN).to?.name).toBe('UW Arboretum Visitor Center (Gallistel)')
    expect(parseLaunchParams(new URL(share('東京 タワー')).search, KNOWN).to?.name).toBe('東京 タワー')
    // Links shared before the change wrote spaces as "+" or "%20".
    expect(parseLaunchParams('?to=43.0418,-89.4153&toName=UW+Arboretum+Visitor+Center', KNOWN).to?.name).toBe('UW Arboretum Visitor Center')
    expect(parseLaunchParams('?to=43.0418,-89.4153&toName=UW%20Arboretum', KNOWN).to?.name).toBe('UW Arboretum')
  })

  it('round-trips a multi-stop trip: every stop, docks or places, and the leg shown', () => {
    const url = buildRideShareUrl('https://bcycle.example', {
      systemId: 'bcycle_madison',
      startId: 's1',
      to: { coord: [-89.4003, 43.07652], name: 'Memorial Union' },
      routeIndex: 2,
      stops: [
        { coord: [-89.4153, 43.0418], name: 'UW Arboretum, Visitor Center (East)', stationId: null },
        { coord: [-89.384, 43.0747], name: 'Capitol Square', stationId: 'bcycle_madison_9' },
      ],
      leg: 1,
    })
    expect(url).not.toMatch(/[\s+]/)
    // An app without trips still reads leg 1 from start/to; the link ends in a number, never a name.
    expect(url).toMatch(/&toName=Memorial_Union&to=43\.076520%2C-89\.400300&route=2&leg=2$/)
    const p = parseLaunchParams(new URL(url).search, KNOWN)
    expect(p).toMatchObject({ rideStartId: 's1', routeIndex: 2, leg: 1, to: { name: 'Memorial Union' } })
    expect(p.stops).toEqual([
      { coord: [-89.4153, 43.0418], name: 'UW Arboretum, Visitor Center (East)', stationId: null },
      { coord: [-89.384, 43.0747], name: 'Capitol Square', stationId: 'bcycle_madison_9' },
    ])
    expect(stripLaunchParams(url)).toBe('/')
  })

  it('drops a trip with a malformed stop, and a leg out of range', () => {
    const base = '?start=s1&to=43.07652,-89.4003'
    expect(parseLaunchParams(`${base}&stop=43.04,-89.41,,Arb&stop=999,1,,Bad&leg=2`, KNOWN)).toMatchObject({ stops: [], leg: null })
    expect(parseLaunchParams(`${base}&stop=43.04,-89.41,bad id,Arb`, KNOWN).stops).toEqual([])
    expect(parseLaunchParams(`${base}&stop=43.04,-89.41,,Arb&leg=3`, KNOWN)).toMatchObject({ stops: [{ name: 'Arb' }], leg: null })
    expect(parseLaunchParams(`${base}&stop=43.04,-89.41,,&leg=1`, KNOWN)).toMatchObject({ stops: [{ name: null, stationId: null }], leg: 0 })
    // No destination: no trip either.
    expect(parseLaunchParams('?start=s1&stop=43.04,-89.41,,Arb', KNOWN).stops).toEqual([])
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
