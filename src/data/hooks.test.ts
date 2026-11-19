import { afterEach, describe, expect, it } from 'vitest'
import type { StationsResponse } from '../api/contract'
import { resetHttpState, setFetchImpl } from '../lib/http'
import { makeStation } from '../test/factories'
import { createQueryClient, prefetchNearestStations, qk } from './hooks'

describe('first visit: the nearest city and its stations in one request', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    resetHttpState()
  })

  it('names the city the Worker picked and leaves its stations in the cache for the hooks', async () => {
    const body: StationsResponse = { systemId: 'bcycle_boulder', lastUpdatedMs: 1_800_000_000_000, fetchedAtMs: 1_800_000_001_000, stations: [makeStation({ id: 'b1' })] }
    const seen: string[] = []
    restore = setFetchImpl(async (url) => {
      seen.push(url)
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const client = createQueryClient()
    expect(await prefetchNearestStations(client)).toBe('bcycle_boulder')
    expect(seen).toEqual(['/api/stations?system=nearest'])
    expect(client.getQueryData(qk.stations('bcycle_boulder'))).toEqual(body)
  })

  it('resolves to null when the request fails (the app then looks the city up on its own)', async () => {
    restore = setFetchImpl(async () => new Response('{"error":{"code":"upstream_unavailable","message":"busy","retryable":true}}', { status: 503 }))
    const client = createQueryClient()
    expect(await prefetchNearestStations(client)).toBeNull()
    expect(client.getQueryCache().getAll()).toEqual([])
  })
})
