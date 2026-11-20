import { describe, expect, it } from 'vitest'
import { NATIVE_APP } from '../config'
import { buildRideShareUrl, buildStationShareUrl } from '../lib/urlParams'
import { appLinkSearch, shouldOpenLink } from './appLinks'

const ORIGIN = 'https://badgerbikes.app'

describe('links that open the apps', () => {
  it('are the web app’s own share links, read back as their query', () => {
    const station = buildStationShareUrl(ORIGIN, 'bcycle_madison', 'bcycle_madison_1234')
    const ride = buildRideShareUrl(ORIGIN, { systemId: 'bcycle_madison', startId: 's1', to: { coord: [-89.4, 43.07], name: 'Capitol' } })
    expect(appLinkSearch(station, ORIGIN)).toBe('?system=bcycle_madison&station=bcycle_madison_1234')
    expect(appLinkSearch(ride, ORIGIN)).toBe(new URL(ride).search)
    expect(appLinkSearch(`${ORIGIN}/`, ORIGIN)).toBe('')
  })

  it('never another site, another page (the dashboard), or a lookalike', () => {
    for (const url of ['https://evil.example/?station=1', 'http://badgerbikes.app/?station=1', `${ORIGIN}/analytics`, 'https://badgerbikes.app.evil.example/?station=1', 'not a url', 'capacitor://localhost/?station=1']) {
      expect(appLinkSearch(url, ORIGIN)).toBeNull()
    }
    expect(appLinkSearch(`${ORIGIN}/?station=1`, '')).toBeNull() // a web build has no apps' origin
  })

  it('open once: not again after a reload, and once for an iPhone cold start’s two reports', () => {
    const url = `${ORIGIN}/?station=1`
    const t0 = 1_800_000_000_000
    expect(shouldOpenLink(url, 'launch', null, t0)).toBe(true)
    const opened = { url, atMs: t0 }
    // The page reloads: the launch URL is reported again, however long after.
    expect(shouldOpenLink(url, 'launch', opened, t0 + 3_600_000)).toBe(false)
    // iPhone: the event for the same launch, moments later.
    expect(shouldOpenLink(url, 'event', opened, t0 + 500)).toBe(false)
    // The rider opens the same link again later, or another link.
    expect(shouldOpenLink(url, 'event', opened, t0 + NATIVE_APP.repeatedLinkMs + 1)).toBe(true)
    expect(shouldOpenLink(`${ORIGIN}/?station=2`, 'launch', opened, t0 + 500)).toBe(true)
  })
})
