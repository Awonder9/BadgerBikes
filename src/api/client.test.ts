import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../lib/errors'
import { resetHttpState, setFetchImpl } from '../lib/http'
import { api } from './client'

describe('api client', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    resetHttpState()
  })

  it('builds GET URLs with encoded params and no-store for stations', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    restore = setFetchImpl(async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ places: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await api.geocode('state & main', 'bcycle_madison', [-89.401234, 43.071234])
    expect(seen[0]!.url).toBe('/api/geocode?q=state+%26+main&system=bcycle_madison&lat=43.07123&lon=-89.40123')
    await api.stations('bcycle_madison').catch(() => {})
    expect(seen[1]!.url).toBe('/api/stations?system=bcycle_madison')
    expect(seen[1]!.init?.cache).toBe('no-store')
  })

  it('rejects with the server AppError for a failed route request', async () => {
    restore = setFetchImpl(async () => new Response(JSON.stringify({ error: { code: 'location_unroutable', message: 'Move the pin', retryable: false } }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const err = (await api.routes({ systemId: 'bcycle_madison', role: 'ride', mode: 'bike', from: [-89.38, 43.07], to: [-89.4, 43.076], units: 'imperial', language: 'en-US' }).catch((e: unknown) => e)) as AppError
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('location_unroutable')
  })
})
