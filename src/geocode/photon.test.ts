import { describe, expect, it } from 'vitest'
import search from '../test/fixtures/photon/search_memorial_union.json'
import partial from '../test/fixtures/photon/search_partial.json'
import reverse from '../test/fixtures/photon/reverse.json'
import { normalizePhotonReverse, normalizePhotonSearch, searchPlaces } from './photon'
import type { UpstreamFetch } from '../lib/upstream'

describe('photon', () => {
  it('builds labelled, de-duplicated places', () => {
    const places = normalizePhotonSearch(search)
    expect(places.length).toBeGreaterThan(0)
    expect(places[0]!.name).toBe('Memorial Union')
    expect(places.some((p) => p.detail?.includes('Langdon Street'))).toBe(true)
    const keys = places.map((p) => `${p.name}|${p.detail}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(normalizePhotonSearch(partial).every((p) => p.kind === 'search')).toBe(true)
  })
  it('reverse geocodes and returns null when empty', () => {
    expect(normalizePhotonReverse(reverse, [-89.3842, 43.07467])?.kind).toBe('mapPick')
    expect(normalizePhotonReverse({ features: [] }, [0, 0])).toBeNull()
  })
  it('skips short queries and filters to the padded bbox', async () => {
    const up = (async () => search) as unknown as UpstreamFetch
    expect(await searchPlaces('ab', { center: [-89.4, 43.07], bbox: [-89.5, 43.0, -89.3, 43.1] }, up)).toEqual([])
    const res = await searchPlaces('memorial union', { center: [-89.4, 43.07], bbox: [-89.5, 43.0, -89.3, 43.1] }, up)
    expect(res.length).toBeGreaterThan(0)
    expect(await searchPlaces('memorial union', { center: [-75, 40], bbox: [-75.1, 39.9, -75.0, 40.0] }, up)).toEqual([])
  })
})

describe('searchBias', () => {
  const sys = { bbox: [-89.5, 43.0, -89.3, 43.15] as [number, number, number, number], center: [-89.4, 43.07] as [number, number] }
  it('uses the rider position rounded to ~1 km inside the area, else the system center', async () => {
    const { searchBias } = await import('./photon')
    expect(searchBias(sys, [-89.401234, 43.071234]).center).toEqual([-89.4, 43.07])
    expect(searchBias(sys, [-80, 40]).center).toEqual(sys.center)
    expect(searchBias(sys, null).center).toEqual(sys.center)
  })
})

