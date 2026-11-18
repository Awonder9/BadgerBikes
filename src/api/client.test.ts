import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../lib/errors'
import { resetHttpState, setFetchImpl } from '../lib/http'
import workerGeocode from '../test/fixtures/api/geocode_apex_grill.json'
import photonSearch from '../test/fixtures/photon/search_memorial_union.json'
import { api } from './client'

describe('api client', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    resetHttpState()
  })

  it('searches Photon directly from the browser (biased to the system), and builds no-store station URLs', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    restore = setFetchImpl(async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(photonSearch), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const places = await api.geocode('memorial union', 'bcycle_madison', [-89.401234, 43.071234])
    // Position rounded to ~1 km before it leaves the device.
    expect(seen[0]!.url).toMatch(/^https:\/\/photon\.komoot\.io\/api\/\?q=memorial\+union&lat=43\.07000&lon=-89\.40000/)
    expect(places.length).toBeGreaterThan(0)
    await api.stations('bcycle_madison').catch(() => {})
    expect(seen[1]!.url).toBe('/api/stations?system=bcycle_madison')
    expect(seen[1]!.init?.cache).toBe('no-store')
  })

  it('falls back to the Worker when Photon fails', async () => {
    const seen: string[] = []
    restore = setFetchImpl(async (url) => {
      seen.push(url)
      if (url.startsWith('https://photon')) return new Response('down', { status: 521 })
      return new Response(JSON.stringify(workerGeocode), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const places = await api.geocode('apex grill', 'bcycle_madison', null)
    expect(seen[1]).toBe('/api/geocode?q=apex+grill&system=bcycle_madison')
    expect(places.map((p) => p.name)).toEqual(['Apex Grill'])
  })

  it('rejects with the server AppError for a failed route request', async () => {
    restore = setFetchImpl(async () => new Response(JSON.stringify({ error: { code: 'location_unroutable', message: 'Move the pin', retryable: false } }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const err = (await api.routes({ systemId: 'bcycle_madison', role: 'ride', mode: 'bike', from: [-89.38, 43.07], to: [-89.4, 43.076], units: 'imperial', language: 'en-US' }).catch((e: unknown) => e)) as AppError
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('location_unroutable')
  })
})
