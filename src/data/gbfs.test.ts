import { describe, expect, it } from 'vitest'
import { CACHE_TTL_MS, ENDPOINTS } from '../config'
import { AppError } from '../lib/errors'
import type { UpstreamFetch, UpstreamRequest } from '../lib/upstream'
import allPricing from '../test/fixtures/gbfs/all_system_pricing_plans.json'
import allSystemInformation from '../test/fixtures/gbfs/all_system_information.json'
import bismarck404 from '../test/fixtures/gbfs/bismarck_404.json'
import laInfo from '../test/fixtures/gbfs/lametro_station_information.json'
import laStatus from '../test/fixtures/gbfs/lametro_station_status.json'
import madisonInfo from '../test/fixtures/gbfs/madison_station_information.json'
import madisonStatus from '../test/fixtures/gbfs/madison_station_status.json'
import madisonSystemInformation from '../test/fixtures/gbfs/madison_system_information.json'
import madisonPricing from '../test/fixtures/gbfs/madison_system_pricing_plans.json'
import madisonStatusV2 from '../test/fixtures/gbfs/madison_v2_station_status.json'
import truckeeInfo from '../test/fixtures/gbfs/truckee_station_information.json'
import truckeeStatus from '../test/fixtures/gbfs/truckee_station_status.json'
import {
  MAX_INCLUDED_MINUTES,
  buildSnapshot,
  fetchStationsSnapshot,
  fetchSystemDetails,
  gbfsFeedUrl,
  mergeStations,
  normalizeHttpsUrl,
  normalizeStationInformation,
  normalizeStationStatus,
  normalizeSystemDetails,
  parseIncludedMinutes,
  stationStatusTtlMs,
} from './gbfs'

type Json = Record<string, unknown>

/** Deep copy of a fixture so a test can mutate it. */
const clone = <T>(v: T): T => structuredClone(v)

/** A real fixture feed with its station list replaced (edge cases built from real station records). */
function withStations(feed: { data: { stations: unknown[] } }, edit: (stations: Json[]) => unknown[]): Json {
  const copy = clone(feed) as { data: { stations: Json[] } }
  return { ...copy, data: { stations: edit(copy.data.stations) } }
}

function firstStation(feed: { data: { stations: unknown[] } }): Json {
  return clone(feed.data.stations[0]) as Json
}

describe('gbfsFeedUrl', () => {
  it('builds the unversioned feed URL from the configured base (no discovery)', () => {
    expect(gbfsFeedUrl('bcycle_madison', 'station_status')).toBe(`${ENDPOINTS.gbfsBase}/bcycle_madison/station_status.json`)
    expect(gbfsFeedUrl('bcycle_madison', 'system_pricing_plans')).toBe(`${ENDPOINTS.gbfsBase}/bcycle_madison/system_pricing_plans.json`)
  })

  it('cannot be steered to another path by the id', () => {
    expect(gbfsFeedUrl('../x?y#z', 'station_information')).toBe(`${ENDPOINTS.gbfsBase}/..%2Fx%3Fy%23z/station_information.json`)
  })
})

describe('normalizeStationInformation', () => {
  const madison = normalizeStationInformation(madisonInfo)

  it('normalizes every Madison station in feed order with [lon, lat] coordinates', () => {
    expect(madison).toHaveLength(madisonInfo.data.stations.length)
    expect(madison.map((s) => s.id)).toEqual(madisonInfo.data.stations.map((s) => s.station_id))
    expect(madison[0]).toEqual({
      id: 'bcycle_madison_1874',
      name: 'Wisconsin & E. Mifflin',
      address: '117 Wisconsin Avenue',
      coord: [-89.38527, 43.07571],
      regionId: 'bcycle_madison_region_42',
      hasKiosk: true,
      rentalUris: {
        ios: 'https://www.bcycle.com/applink?system_id=bcycle_madison&station_id=bcycle_madison_1874&platform=iOS',
        android: 'https://www.bcycle.com/applink?system_id=bcycle_madison&station_id=bcycle_madison_1874&platform=android',
      },
    })
  })

  it('trims names (Madison and LA Metro have trailing spaces) and keeps "&" verbatim', () => {
    const raw = madisonInfo.data.stations.find((s) => s.name === 'W. Washington & Regent St.  ')
    expect(raw).toBeDefined()
    expect(madison.find((s) => s.id === raw?.station_id)?.name).toBe('W. Washington & Regent St.')
    expect(madison.every((s) => s.name === s.name.trim())).toBe(true)
    const la = normalizeStationInformation(laInfo)
    expect(la.map((s) => s.name)).toContain('30th & University')
    expect(la.map((s) => s.name)).toContain('Argyle & Hollywood')
  })

  it('derives hasKiosk from _bcycle_station_type', () => {
    const types = new Map(madisonInfo.data.stations.map((s) => [s.station_id, s['_bcycle_station_type']]))
    expect(madison.some((s) => !s.hasKiosk)).toBe(true)
    for (const s of madison) expect(s.hasKiosk).toBe(types.get(s.id) === 'Kiosk and Station')
  })

  it('maps a missing region_id (LA Metro) to null', () => {
    const la = normalizeStationInformation(laInfo)
    expect(la.find((s) => s.id === 'bcycle_lametro_4734')?.regionId).toBeNull()
  })

  it('drops stations with invalid or (0, 0) coordinates and without an id', () => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, (stations) => [
      { ...base, station_id: 'zero', lat: 0, lon: 0 },
      { ...base, station_id: 'nan', lat: Number.NaN },
      { ...base, station_id: 'string', lat: 'north' },
      { ...base, station_id: 'out-of-range', lat: 91 },
      { ...base, station_id: 'missing', lon: undefined },
      { ...base, station_id: undefined },
      { ...base, station_id: '   ' },
      null,
      'garbage',
      ...stations.slice(0, 2),
    ])
    expect(normalizeStationInformation(feed).map((s) => s.id)).toEqual(['bcycle_madison_1874', 'bcycle_madison_1878'])
  })

  it('accepts numeric-string coordinates and numeric ids', () => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, () => [{ ...base, station_id: 42, lat: '43.07571', lon: '-89.38527' }])
    const [s] = normalizeStationInformation(feed)
    expect(s?.id).toBe('42')
    expect(s?.coord).toEqual([-89.38527, 43.07571])
  })

  it('keeps the first of duplicated station ids', () => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, () => [base, { ...base, name: 'Duplicate' }])
    expect(normalizeStationInformation(feed).map((s) => s.name)).toEqual(['Wisconsin & E. Mifflin'])
  })

  it('falls back to the id for a missing name and to null for a blank address', () => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, () => [{ ...base, name: '  ', address: '' }])
    expect(normalizeStationInformation(feed)[0]).toMatchObject({ name: 'bcycle_madison_1874', address: null })
  })

  it.each([
    ['https://www.bcycle.com/applink?station_id=1', 'https://www.bcycle.com/applink?station_id=1'],
    ['https://bcycle.com/applink', 'https://bcycle.com/applink'],
    ['https://madison.bcycle.com/x', 'https://madison.bcycle.com/x'],
    ['http://www.bcycle.com/applink', null],
    ['https://evilbcycle.com/applink', null],
    ['https://bcycle.com.evil.example/applink', null],
    ['https://user:pw@www.bcycle.com/applink', null],
    ['javascript:alert(1)', null],
    ['bcycle://station/1', null],
    ['not a url', null],
    [42, null],
  ])('keeps only https rental URIs on bcycle.com: %s', (uri, expected) => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, () => [{ ...base, rental_uris: { ios: uri, android: uri } }])
    expect(normalizeStationInformation(feed)[0]?.rentalUris).toEqual({ ios: expected, android: expected })
  })

  it('handles a missing rental_uris object', () => {
    const base = firstStation(madisonInfo)
    const feed = withStations(madisonInfo, () => [{ ...base, rental_uris: undefined }])
    expect(normalizeStationInformation(feed)[0]?.rentalUris).toEqual({ ios: null, android: null })
  })

  it('returns [] for a seasonal system with no stations (bcycle_truckee)', () => {
    expect(normalizeStationInformation(truckeeInfo)).toEqual([])
  })

  it.each([
    ['a GBFS 404 body', bismarck404],
    ['null', null],
    ['an empty data object', { data: {} }],
    ['a non-array station list', { data: { stations: {} } }],
  ])('rejects %s with bad_response', (_label, json) => {
    expect(() => normalizeStationInformation(json)).toThrow(expect.objectContaining({ code: 'bad_response', provider: 'gbfs' }))
  })
})

describe('normalizeStationStatus', () => {
  it('converts last_updated (epoch seconds) to ms', () => {
    expect(normalizeStationStatus(madisonStatus).lastUpdatedMs).toBe(madisonStatus.last_updated * 1000)
    expect(normalizeStationStatus(truckeeStatus).lastUpdatedMs).toBe(truckeeStatus.last_updated * 1000)
  })

  it('passes through timestamps that are already in ms', () => {
    expect(normalizeStationStatus({ ...madisonStatus, last_updated: 1_794_945_034_000 }).lastUpdatedMs).toBe(1_794_945_034_000)
  })

  it('reads GBFS 1.1 (0/1) and 2.1 (true/false) flags identically', () => {
    const v1 = normalizeStationStatus(madisonStatus).statuses
    const v2 = normalizeStationStatus(madisonStatusV2).statuses
    expect(v1.size).toBe(madisonStatus.data.stations.length)
    expect([...v2.keys()]).toEqual([...v1.keys()])
    for (const [id, s] of v1) {
      const other = v2.get(id)
      expect({ i: other?.isInstalled, r: other?.isRenting, d: other?.isReturning }).toEqual({ i: s.isInstalled, r: s.isRenting, d: s.isReturning })
    }
    expect(v1.get('bcycle_madison_1874')).toEqual({ bikes: 5, docks: 4, ebikes: 5, classic: 0, isInstalled: true, isRenting: true, isReturning: true })
    expect(v2.get('bcycle_madison_1874')).toEqual({ bikes: 5, docks: 4, ebikes: 5, classic: 0, isInstalled: true, isRenting: true, isReturning: true })
  })

  it('keeps the LA Metro flag combinations (1,0,0) and (0,0,0) and the mixed fleet split', () => {
    const { statuses } = normalizeStationStatus(laStatus)
    expect(statuses.get('bcycle_lametro_3058')).toEqual({ bikes: 8, docks: 7, ebikes: 1, classic: 7, isInstalled: true, isRenting: false, isReturning: false })
    expect(statuses.get('bcycle_lametro_4494')).toEqual({ bikes: 0, docks: 9, ebikes: 0, classic: 0, isInstalled: false, isRenting: false, isReturning: false })
    const flagged = [...statuses].filter(([, s]) => !(s.isInstalled && s.isRenting && s.isReturning)).map(([id]) => id)
    expect(flagged).toEqual(['bcycle_lametro_3058', 'bcycle_lametro_4207', 'bcycle_lametro_4473', 'bcycle_lametro_4494', 'bcycle_lametro_4566'])
  })

  it('reports null bike types when num_bikes_available_types is absent', () => {
    const base = firstStation(madisonStatus)
    const feed = { ...withStations(madisonStatus, () => [{ ...base, num_bikes_available_types: undefined }]), last_updated: madisonStatus.last_updated }
    expect(normalizeStationStatus(feed).statuses.get('bcycle_madison_1874')).toMatchObject({ bikes: 5, ebikes: null, classic: null })
  })

  it('treats only true and 1 as true', () => {
    const base = firstStation(madisonStatus)
    const feed = {
      ...withStations(madisonStatus, () => [{ ...base, is_installed: 'true', is_renting: '1', is_returning: 2 }]),
      last_updated: madisonStatus.last_updated,
    }
    expect(normalizeStationStatus(feed).statuses.get('bcycle_madison_1874')).toMatchObject({ isInstalled: false, isRenting: false, isReturning: false })
  })

  it('normalizes counts to non-negative integers', () => {
    const base = firstStation(madisonStatus)
    const feed = {
      ...withStations(madisonStatus, () => [{ ...base, num_bikes_available: -3, num_docks_available: 2.7, num_bikes_available_types: { classic: '4', electric: null } }]),
      last_updated: madisonStatus.last_updated,
    }
    expect(normalizeStationStatus(feed).statuses.get('bcycle_madison_1874')).toMatchObject({ bikes: 0, docks: 2, classic: 4, ebikes: 0 })
  })

  it('skips entries without an id and keeps the first duplicate', () => {
    const base = firstStation(madisonStatus)
    const feed = {
      ...withStations(madisonStatus, () => [{ ...base, station_id: null }, base, { ...base, num_bikes_available: 99 }, 7]),
      last_updated: madisonStatus.last_updated,
    }
    const { statuses } = normalizeStationStatus(feed)
    expect([...statuses.keys()]).toEqual(['bcycle_madison_1874'])
    expect(statuses.get('bcycle_madison_1874')?.bikes).toBe(5)
  })

  it('returns an empty map for bcycle_truckee', () => {
    expect(normalizeStationStatus(truckeeStatus).statuses.size).toBe(0)
  })

  it.each([
    ['a missing last_updated', { data: { stations: [] } }],
    ['a zero last_updated', { last_updated: 0, data: { stations: [] } }],
    ['a GBFS 404 body', bismarck404],
    ['a string', 'nope'],
  ])('rejects %s with bad_response', (_label, json) => {
    expect(() => normalizeStationStatus(json)).toThrow(expect.objectContaining({ code: 'bad_response' }))
  })
})

describe('mergeStations / buildSnapshot', () => {
  it('merges in station_information order with null status for stations missing from station_status', () => {
    const info = normalizeStationInformation(laInfo)
    const statusFeed = withStations(laStatus, (stations) => stations.filter((s) => s.station_id !== 'bcycle_lametro_4207').toReversed())
    const { statuses } = normalizeStationStatus({ ...statusFeed, last_updated: laStatus.last_updated })
    const merged = mergeStations(info, statuses)
    expect(merged.map((s) => s.id)).toEqual(info.map((s) => s.id))
    expect(merged.find((s) => s.id === 'bcycle_lametro_4207')?.status).toBeNull()
    expect(merged.filter((s) => s.status === null)).toHaveLength(1)
    expect(merged.find((s) => s.id === 'bcycle_lametro_3058')?.status?.isRenting).toBe(false)
  })

  it('ignores statuses for stations not in station_information', () => {
    const { statuses } = normalizeStationStatus(madisonStatus)
    const info = normalizeStationInformation(madisonInfo).slice(0, 3)
    expect(mergeStations(info, statuses)).toHaveLength(3)
  })

  it('builds byId and carries both timestamps', () => {
    const stations = mergeStations(normalizeStationInformation(madisonInfo), normalizeStationStatus(madisonStatus).statuses)
    const snap = buildSnapshot('bcycle_madison', stations, 1_000, 2_000)
    expect(snap).toMatchObject({ systemId: 'bcycle_madison', lastUpdatedMs: 1_000, fetchedAtMs: 2_000 })
    expect(snap.byId.size).toBe(stations.length)
    expect(snap.byId.get('bcycle_madison_1874')).toBe(stations[0])
  })
})

describe('stationStatusTtlMs', () => {
  const lastUpdatedS = madisonStatus.last_updated
  const lastUpdatedMs = lastUpdatedS * 1000

  it('caches until last_updated + 62 s', () => {
    expect(stationStatusTtlMs(madisonStatus, lastUpdatedMs + 10_000)).toBe(52_000)
    expect(stationStatusTtlMs(madisonStatus, lastUpdatedMs + 30_000)).toBe(32_000)
  })

  it('clamps to the configured range', () => {
    expect(stationStatusTtlMs(madisonStatus, lastUpdatedMs + 60_000)).toBe(CACHE_TTL_MS.stationStatusMin)
    expect(stationStatusTtlMs(madisonStatus, lastUpdatedMs + 10 * 60_000)).toBe(CACHE_TTL_MS.stationStatusMin)
    // Feed clock ahead of ours.
    expect(stationStatusTtlMs(madisonStatus, lastUpdatedMs - 30_000)).toBe(CACHE_TTL_MS.stationStatusMax)
  })

  it('uses the minimum for an unreadable body', () => {
    expect(stationStatusTtlMs(null, lastUpdatedMs)).toBe(CACHE_TTL_MS.stationStatusMin)
    expect(stationStatusTtlMs({ last_updated: 'soon' }, lastUpdatedMs)).toBe(CACHE_TTL_MS.stationStatusMin)
  })
})

describe('parseIncludedMinutes', () => {
  it.each([
    // [name, description, expected] — real pass texts from BCycle pricing feeds (2026-11-17)
    ['Annual Pass', 'Price includes 60 minutes per ride, after each unlock. \n\nFor each trip >60 minutes: add $8 for each additional 30-minute period.', 60],
    ['Single Ride', '$5 per 15 minutes.', 15],
    ['Annual Pass (120 minute rides)', '$160 (tax included). Enjoy unlimited 120-minute rides for a year!', 120],
    ['Visit Milwaukee', 'Take as many 2-hour trips as you want for the next three days. Individual trips lasting longer than 2 hours will be charged $0.25 per minute plus tax.', 120],
    ['Annual Membership', 'Auto-renew membership includes unlimited 90min docks for 1yr. MUST DOCK BIKE ONCE PER 90 MINS TO AVOID USAGE FEES.', 90],
    ['eBike Pass ', '$5.00 for first 20 minutes \n+30 cents per minute for each additional minute billed the next day\n+$1.00 unlock service fee', 20],
    ['Pay Per Minute: $1 + $0.45/minute', '$1 to unlock plus $0.45/minute\nReturn your bike to a station to end your ride.', null],
    ['Aluminum Access', 'An annual pass with unlimited 1 hour trips. Rides lasting longer than 1 hour incur overage fees of $6 each additional hour.', 60],
    ['Monthly Membership', 'Auto-renew membership includes unlimited 1hr trips for 31 days. MUST DOCK BIKE ONCE PER HOUR TO AVOID USAGE FEES.', 60],
    ['Rent a Bike', '$6.00 for 3 hours / $2.00 each additional hour', 180],
    ['UW-Madison Monthly Member', 'Includes rides of 30 minutes or less. Rides over 30 minutes incur $8 usage fee per additional 30 minutes.', 30],
    // A billing period ("/ 30 minutes", "per 30 mins", "every 30 minutes") ranks below the allowance.
    ['CU Student and Employee', 'Use CU-issued Identikey email.\n\nAdditional $7.63 / 30 minutes for rides over 60 minutes. Tax included. ', 60],
    ['2 Hour - Single Ride', '$17.50 for up to a 2 hour ride\n\nAdditional time $9.30 per 30 mins', 120],
    ['Swamp Rabbit Pass', 'Take a ride on the Swamp Rabbit Trail with this 4-hour pass. $35 plus tax for 4-hours and $10 plus tax every 30 minutes thereafter.', 240],
    // Durations that are not per-ride allowances are ignored.
    ['Pay as You Ride', 'Classic Bikes: $0.20/Min. \nE-Bikes: $3 fee + $0.25/Min. \n\nCharges may take up to 48 hours after returning the bike to process.', null],
    ['Per-Minute ($0.05-$0.30/Min)', 'Electric Bikes: $1.00 Unlock + $0.30 per minute', null],
    // Falls back to the name.
    ['Single Ride Pass (30 min)', '', 30],
    ['1 Day Pass (Kiosk only)', '', null],
    ['Indego30', ' ', null],
    // Decimal hours; "minimum" is not "min".
    ['Long Ride', 'Includes 1.5 hours per ride. $5 minimum charge.', 90],
  ])('%s → %s', (name, description, expected) => {
    expect(parseIncludedMinutes(name, description)).toBe(expected)
  })

  it('gives a plausible value or null for every live BCycle plan', () => {
    const results = Object.entries(allPricing as Record<string, { data: { plans?: Array<{ name: string; description?: string }> } }>).flatMap(([systemId, feed]) =>
      (feed.data.plans ?? []).map((p) => ({ systemId, name: p.name, minutes: parseIncludedMinutes(p.name, p.description ?? '') })),
    )
    expect(results.length).toBeGreaterThan(100)
    const implausible = results.filter((r) => r.minutes !== null && !(Number.isInteger(r.minutes) && r.minutes >= 1 && r.minutes <= MAX_INCLUDED_MINUTES))
    expect(implausible).toEqual([])
    const byName = (systemId: string, name: string) => results.find((r) => r.systemId === systemId && r.name === name)?.minutes
    expect(byName('bcycle_madison', 'Single Ride Pass (30 min)')).toBe(30)
    expect(byName('bcycle_nashville', 'Day Pass (120 minute rides)')).toBe(120)
    expect(byName('bcycle_santacruz', '5 Minute Single Ride - $5 unlock + 50c/min')).toBe(5)
    expect(byName('bcycle_bublr', '$0.25 per minute')).toBeNull()
    // "24 hours" is the pass validity, not a ride allowance within MAX_INCLUDED_MINUTES.
    expect(byName('bcycle_bublr', '24-Hour Pass')).toBeNull()
    expect(byName('bcycle_lametro', '1-Ride')).toBe(30)
  })
})

describe('normalizeHttpsUrl', () => {
  it.each([
    ['madison.bcycle.com', 'https://madison.bcycle.com/'],
    ['www.explorebikeshare.com', 'https://www.explorebikeshare.com/'],
    ['http://bublrbikes.org', 'https://bublrbikes.org/'],
    ['https://bikelnk.com/', 'https://bikelnk.com/'],
    ['//example.org/x', 'https://example.org/x'],
    ['  https://shastalivingstreets.org/redding-bikeshare/ ', 'https://shastalivingstreets.org/redding-bikeshare/'],
    ['javascript:alert(1)', null],
    ['ftp://example.org', null],
    ['https://user:pw@example.org', null],
    ['localhost', null],
    ['two words.com', null],
    ['', null],
    [null, null],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeHttpsUrl(raw)).toBe(expected)
  })
})

describe('normalizeSystemDetails', () => {
  it('normalizes Madison system information and pricing', () => {
    const details = normalizeSystemDetails('bcycle_madison', madisonSystemInformation, madisonPricing)
    expect(details).toMatchObject({
      systemId: 'bcycle_madison',
      name: 'Madison BCycle',
      timezone: 'America/Chicago',
      phone: '800.473.4743',
      email: 'madison@bcycle.com',
      websiteUrl: 'https://madison.bcycle.com/',
      rentalApps: {
        ios: { discoveryUri: 'bcycle://', storeUri: 'https://apps.apple.com/us/app/bcycle/id371185597' },
        android: { discoveryUri: 'bcycle://', storeUri: 'https://play.google.com/store/apps/details?id=com.bcycle' },
      },
      defaultIncludedMinutes: 30,
    })
    expect(details.passes.map((p) => [p.id, p.name, p.price, p.currency, p.includedMinutes, p.url])).toEqual([
      ['bcycle_madison_84', 'Annual Pass', 180, 'USD', 60, 'https://madison.bcycle.com/'],
      ['bcycle_madison_938', 'Guest Pass', 20, 'USD', 60, 'https://madison.bcycle.com/'],
      ['bcycle_madison_306', 'Monthly Pass', 35, 'USD', 60, 'https://madison.bcycle.com/'],
      ['bcycle_madison_583', 'Single Ride Pass (30 min)', 8, 'USD', 30, 'https://madison.bcycle.com/'],
      ['bcycle_madison_954', 'UW-Madison Monthly Member', 10, 'USD', 30, 'https://madison.bcycle.com/'],
    ])
    expect(details.passes[0]?.description.startsWith('Price includes 60 minutes per ride')).toBe(true)
  })

  it('degrades to no passes when pricing is missing or malformed', () => {
    for (const pricing of [null, undefined, bismarck404, { data: {} }, { data: { plans: 'x' } }]) {
      const details = normalizeSystemDetails('bcycle_madison', madisonSystemInformation, pricing)
      expect(details.passes).toEqual([])
      expect(details.defaultIncludedMinutes).toBeNull()
    }
  })

  it('handles every live system: trims names/emails, https websites, app links, passes', () => {
    const infos = allSystemInformation as Record<string, unknown>
    const pricing = allPricing as Record<string, unknown>
    for (const [systemId, info] of Object.entries(infos)) {
      const d = normalizeSystemDetails(systemId, info, pricing[systemId])
      expect(d.name).toBe(d.name.trim())
      expect(d.name.length).toBeGreaterThan(0)
      expect(d.rentalApps.ios?.discoveryUri).toBe('bcycle://')
      expect(d.rentalApps.android?.storeUri).toBe('https://play.google.com/store/apps/details?id=com.bcycle')
      expect(d.websiteUrl?.startsWith('https://')).toBe(true)
      for (const p of d.passes) expect(p.url === null || p.url.startsWith('https://')).toBe(true)
    }
    const desMoines = normalizeSystemDetails('bcycle_desmoines', infos.bcycle_desmoines, pricing.bcycle_desmoines)
    expect(desMoines.name).toBe('Des Moines Street Collective')
    expect(desMoines.email).toBe('bikeshare@dsmstreetcollective.org')
    expect(desMoines.defaultIncludedMinutes).toBe(15)
    const bublr = normalizeSystemDetails('bcycle_bublr', infos.bcycle_bublr, pricing.bcycle_bublr)
    expect(bublr.websiteUrl).toBe('https://bublrbikes.org/')
    // bcycle_bentonville publishes system_pricing_plans with an empty data object.
    expect(normalizeSystemDetails('bcycle_bentonville', infos.bcycle_bentonville, pricing.bcycle_bentonville).passes).toEqual([])
  })

  it('rejects unsafe app links and contact fields', () => {
    const info = clone(madisonSystemInformation) as unknown as { data: Json }
    info.data.rental_apps = {
      ios: { discovery_uri: 'javascript://alert(1)', store_uri: 'https://apps.apple.com/us/app/bcycle/id371185597' },
      android: { discovery_uri: 'bcycle://', store_uri: 'https://evil.example/app' },
    }
    info.data.email = 'not an email'
    info.data.url = 'javascript:alert(1)'
    info.data.timezone = '../../etc'
    info.data.name = ''
    const d = normalizeSystemDetails('bcycle_madison', info, madisonPricing)
    expect(d.rentalApps).toEqual({ ios: null, android: null })
    expect(d).toMatchObject({ email: null, websiteUrl: null, timezone: 'UTC', name: 'bcycle_madison' })
  })

  it('skips plans without an id or a valid price and defaults the currency', () => {
    const plans = clone(madisonPricing)
    const [a, b, c] = plans.data.plans as Json[]
    if (!a || !b || !c) throw new Error('fixture changed')
    a.plan_id = undefined
    b.price = 'free'
    c.currency = 'dollars'
    const d = normalizeSystemDetails('bcycle_madison', madisonSystemInformation, plans)
    expect(d.passes.map((p) => p.id)).toEqual(['bcycle_madison_306', 'bcycle_madison_583', 'bcycle_madison_954'])
    expect(d.passes[0]?.currency).toBe('USD')
  })

  it('rejects system_information without data', () => {
    expect(() => normalizeSystemDetails('bcycle_bismarck', bismarck404, null)).toThrow(expect.objectContaining({ code: 'bad_response' }))
  })
})

// ─── Fetchers (fake UpstreamFetch over the captured feeds) ─────────────────────────────────────────

function fakeUpstream(feeds: Record<string, unknown>, opts: { fail?: Record<string, AppError> } = {}) {
  const calls: UpstreamRequest[] = []
  const upstream: UpstreamFetch = <T,>(req: UpstreamRequest): Promise<T> => {
    calls.push(req)
    const feed = /\/([a-z_]+)\.json$/.exec(req.url)?.[1] ?? ''
    const failure = opts.fail?.[feed]
    if (failure) return Promise.reject(failure)
    if (!(feed in feeds)) return Promise.reject(new AppError('http', `HTTP 404 for ${req.url}`, { status: 404, provider: 'gbfs', body: bismarck404 }))
    return Promise.resolve(feeds[feed] as T)
  }
  return { upstream, calls }
}

describe('fetchStationsSnapshot', () => {
  it('fetches both station feeds through the upstream layer and merges them', async () => {
    const { upstream, calls } = fakeUpstream({ station_information: madisonInfo, station_status: madisonStatus })
    const signal = new AbortController().signal
    const nowMs = madisonStatus.last_updated * 1000 + 20_000
    const snap = await fetchStationsSnapshot('bcycle_madison', upstream, { signal, now: () => nowMs })

    expect(snap.systemId).toBe('bcycle_madison')
    expect(snap.stations).toHaveLength(111)
    expect(snap.lastUpdatedMs).toBe(madisonStatus.last_updated * 1000)
    expect(snap.fetchedAtMs).toBe(nowMs)
    expect(snap.byId.get('bcycle_madison_1874')?.status?.bikes).toBe(5)

    const info = calls.find((c) => c.url.endsWith('/station_information.json'))
    const status = calls.find((c) => c.url.endsWith('/station_status.json'))
    expect(info).toMatchObject({
      url: gbfsFeedUrl('bcycle_madison', 'station_information'),
      group: null,
      priority: 'interactive',
      provider: 'gbfs',
      signal,
      cacheKey: 'gbfs:bcycle_madison:station_information',
      cacheTtlMs: CACHE_TTL_MS.stationInformation,
    })
    expect(status).toMatchObject({ group: null, priority: 'interactive', provider: 'gbfs', cacheKey: 'gbfs:bcycle_madison:station_status', signal })
    const ttl = status?.cacheTtlMs
    expect(typeof ttl).toBe('function')
    const ttlFn = typeof ttl === 'function' ? ttl : () => Number.NaN
    // last_updated + 62 s − now (last_updated + 20 s)
    expect(ttlFn(madisonStatus)).toBe(42_000)
  })

  it('returns an empty snapshot for a seasonal system', async () => {
    const { upstream } = fakeUpstream({ station_information: truckeeInfo, station_status: truckeeStatus })
    const snap = await fetchStationsSnapshot('bcycle_truckee', upstream, { now: () => 1 })
    expect(snap.stations).toEqual([])
    expect(snap.byId.size).toBe(0)
  })

  it('maps a GBFS 404 to not_found', async () => {
    const { upstream } = fakeUpstream({})
    const err = await fetchStationsSnapshot('bcycle_bismarck', upstream).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'not_found', status: 404, provider: 'gbfs', retryable: false })
  })

  it('passes other upstream errors through', async () => {
    const { upstream } = fakeUpstream(
      { station_information: madisonInfo },
      { fail: { station_status: new AppError('timeout', 'Request timed out', { provider: 'gbfs' }) } },
    )
    await expect(fetchStationsSnapshot('bcycle_madison', upstream)).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('fetchSystemDetails', () => {
  it('fetches system_information + system_pricing_plans with the 1 h TTL', async () => {
    const { upstream, calls } = fakeUpstream({ system_information: madisonSystemInformation, system_pricing_plans: madisonPricing })
    const details = await fetchSystemDetails('bcycle_madison', upstream)
    expect(details.name).toBe('Madison BCycle')
    expect(details.passes).toHaveLength(5)
    expect(calls.map((c) => [c.cacheKey, c.cacheTtlMs, c.group, c.provider])).toEqual([
      ['gbfs:bcycle_madison:system_information', CACHE_TTL_MS.systemInformation, null, 'gbfs'],
      ['gbfs:bcycle_madison:system_pricing_plans', CACHE_TTL_MS.systemInformation, null, 'gbfs'],
    ])
  })

  it('degrades to no passes when the pricing feed fails', async () => {
    const { upstream } = fakeUpstream({ system_information: madisonSystemInformation })
    const details = await fetchSystemDetails('bcycle_madison', upstream)
    expect(details.passes).toEqual([])
    expect(details.defaultIncludedMinutes).toBeNull()
  })

  it('still rejects when the request was aborted', async () => {
    const { upstream } = fakeUpstream(
      { system_information: madisonSystemInformation },
      { fail: { system_pricing_plans: new AppError('aborted', 'Aborted') } },
    )
    await expect(fetchSystemDetails('bcycle_madison', upstream)).rejects.toMatchObject({ code: 'aborted' })
  })

  it('maps a missing system to not_found', async () => {
    const { upstream } = fakeUpstream({})
    await expect(fetchSystemDetails('bcycle_bismarck', upstream)).rejects.toMatchObject({ code: 'not_found' })
  })
})
