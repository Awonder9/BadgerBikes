import { describe, expect, it, vi } from 'vitest'
import { APP } from '../src/config'
import registry from '../src/data/systems.json'
import allSystemInformation from '../src/test/fixtures/gbfs/all_system_information.json'
import bismarck404 from '../src/test/fixtures/gbfs/bismarck_404.json'
import madisonInfo from '../src/test/fixtures/gbfs/madison_station_information.json'
import madisonSystemInformation from '../src/test/fixtures/gbfs/madison_system_information.json'
import truckeeInfo from '../src/test/fixtures/gbfs/truckee_station_information.json'
import {
  GEOCODED_BBOX_HALF_KM,
  USER_AGENT,
  bboxAround,
  bboxOf,
  buildEntry,
  createGeocoder,
  getJson,
  haversine,
  isBcycleRow,
  mapPool,
  medoid,
  parseCsv,
  probeSystem,
  stationCoords,
  systemIdFromUrl,
  validateRegistry,
} from './update-systems.mjs'

const CSV_HEADER = 'Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL,Authentication Type,Authentication Parameter Name'

const row = (id, o = {}) => ({
  'Country Code': 'US',
  Name: o.name ?? `${id} name`,
  Location: o.location ?? 'Madison, WI',
  'System ID': id,
  URL: o.url ?? `https://${id}.example.org`,
  'Auto-Discovery URL': o.discovery ?? `https://gbfs.bcycle.com/${id}/gbfs.json`,
})

describe('USER_AGENT', () => {
  it('is the app User-Agent from src/config.ts', () => {
    expect(USER_AGENT).toBe(APP.userAgent)
  })
})

describe('parseCsv', () => {
  it('parses quoted fields with commas, escaped quotes, CRLF and blank lines', () => {
    const csv = [
      CSV_HEADER,
      'US,Madison B-cycle,"Madison, WI",bcycle_madison,https://madison.bcycle.com,https://gbfs.bcycle.com/bcycle_madison/gbfs.json,1.1,,,',
      '',
      'US,"The ""Best"" Bikes"," Somewhere ",x_y,https://x.example,https://x.example/gbfs.json,2.3,,,',
    ].join('\r\n')
    const rows = parseCsv(`${csv}\r\n`)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ Name: 'Madison B-cycle', Location: 'Madison, WI', 'System ID': 'bcycle_madison' })
    expect(rows[1]).toMatchObject({ Name: 'The "Best" Bikes', Location: 'Somewhere' })
  })

  it('fills missing trailing fields with empty strings and handles an empty input', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual([{ a: '1', b: '2', c: '' }])
    expect(parseCsv('')).toEqual([])
  })
})

describe('systemIdFromUrl / isBcycleRow', () => {
  it('accepts only gbfs.bcycle.com auto-discovery URLs', () => {
    expect(systemIdFromUrl('https://gbfs.bcycle.com/bcycle_madison/gbfs.json')).toBe('bcycle_madison')
    expect(systemIdFromUrl('https://gbfs.bcycle.com/1/bcycle_madison/gbfs.json')).toBeNull()
    expect(systemIdFromUrl('https://gbfs.example.com/bcycle_madison/gbfs.json')).toBeNull()
    expect(systemIdFromUrl('not a url')).toBeNull()
    expect(isBcycleRow(row('bcycle_madison'))).toBe(true)
    expect(isBcycleRow(row('lyft', { discovery: 'https://gbfs.lyft.com/gbfs/2.3/bay/gbfs.json' }))).toBe(false)
  })
})

describe('geometry helpers', () => {
  it('haversine matches a known distance (Capitol → Memorial Union ≈ 1.3 km)', () => {
    expect(haversine([-89.3842, 43.07467], [-89.4003, 43.07652])).toBeCloseTo(1322, -1)
  })

  it('stationCoords keeps valid [lon, lat] and drops (0, 0) and invalid entries', () => {
    expect(stationCoords(madisonInfo)).toHaveLength(madisonInfo.data.stations.length)
    expect(stationCoords(madisonInfo)[0]).toEqual([-89.38527, 43.07571])
    const feed = { data: { stations: [{ lat: 0, lon: 0 }, { lat: Number.NaN, lon: 1 }, { lat: '43', lon: -89 }, { lat: 95, lon: 1 }, { lat: 43.1, lon: -89.4 }, null] } }
    expect(stationCoords(feed)).toEqual([[-89.4, 43.1]])
    expect(stationCoords(truckeeInfo)).toEqual([])
    expect(() => stationCoords(bismarck404)).toThrow(/data\.stations/)
  })

  it('bboxOf rounds to 5 dp and returns null for no points', () => {
    expect(bboxOf([[-89.123456, 43.1], [-89.2, 43.0000049]])).toEqual([-89.2, 43, -89.12346, 43.1])
    expect(bboxOf([])).toBeNull()
  })

  it('medoid is a real station near the bulk of the system, not the mean', () => {
    const cluster = [
      [-89.4, 43.07],
      [-89.401, 43.071],
      [-89.399, 43.072],
    ]
    const outlier = [-88.0, 42.0]
    const center = medoid([...cluster, outlier])
    expect(cluster).toContainEqual(center)
    expect(center).toEqual([-89.4, 43.07])
    expect(medoid([[1.234567, 2.345678]])).toEqual([1.23457, 2.34568])
    expect(medoid([])).toBeNull()
  })

  it('medoid of the Madison stations is one of the stations', () => {
    const points = stationCoords(madisonInfo)
    expect(points.map((p) => p.join())).toContain(medoid(points).join())
  })

  it('bboxAround spans ±halfKm around the center', () => {
    const center = [-120.18, 39.33]
    const [w, s, e, n] = bboxAround(center, GEOCODED_BBOX_HALF_KM)
    expect(haversine(center, [w, center[1]])).toBeCloseTo(5000, -1)
    expect(haversine(center, [e, center[1]])).toBeCloseTo(5000, -1)
    expect(haversine(center, [center[0], s])).toBeCloseTo(5000, -1)
    expect(haversine(center, [center[0], n])).toBeCloseTo(5000, -1)
  })
})

describe('buildEntry', () => {
  it('builds an active entry with the station bbox and medoid center', () => {
    const { system } = buildEntry({ row: row('bcycle_madison', { location: 'Madison, WI' }), systemInformation: madisonSystemInformation, stationInformation: madisonInfo, previous: undefined })
    expect(system).toMatchObject({
      id: 'bcycle_madison',
      name: 'Madison BCycle',
      city: 'Madison, WI',
      url: 'https://madison.bcycle.com/',
      timezone: 'America/Chicago',
      stationCount: 111,
      active: true,
      gbfsUrl: 'https://gbfs.bcycle.com/bcycle_madison/gbfs.json',
    })
    const points = stationCoords(madisonInfo)
    expect(system.bbox).toEqual(bboxOf(points))
    expect(points.map((p) => p.join())).toContain(system.center.join())
    expect(Object.keys(system)).toEqual(['id', 'name', 'city', 'url', 'timezone', 'bbox', 'center', 'stationCount', 'active', 'gbfsUrl'])
    expect(validateRegistry([system])).toEqual([])
  })

  it('trims names and upgrades website URLs to https', () => {
    const desMoines = buildEntry({ row: row('bcycle_desmoines'), systemInformation: allSystemInformation.bcycle_desmoines, stationInformation: madisonInfo })
    expect(desMoines.system.name).toBe('Des Moines Street Collective')
    const bublr = buildEntry({ row: row('bcycle_bublr'), systemInformation: allSystemInformation.bcycle_bublr, stationInformation: madisonInfo })
    expect(bublr.system.url).toBe('https://bublrbikes.org/')
  })

  it('reuses the previously committed bbox/center for a 0-station system and marks it inactive', () => {
    const previous = { id: 'bcycle_truckee', bbox: [-120.2, 39.3, -120.1, 39.35], center: [-120.18, 39.33], timezone: 'America/Los_Angeles' }
    const { system } = buildEntry({ row: row('bcycle_truckee', { location: 'Truckee, CA' }), systemInformation: allSystemInformation.bcycle_truckee, stationInformation: truckeeInfo, previous, geocoded: [0, 0] })
    expect(system).toMatchObject({ bbox: previous.bbox, center: previous.center, stationCount: 0, active: false, city: 'Truckee, CA' })
    expect(validateRegistry([system])).toEqual([])
  })

  it('uses a ±5 km box around the geocoded location when there is no previous entry', () => {
    const { system } = buildEntry({ row: row('bcycle_truckee'), systemInformation: allSystemInformation.bcycle_truckee, stationInformation: truckeeInfo, previous: undefined, geocoded: [-120.1832533, 39.327962] })
    expect(system.center).toEqual([-120.18325, 39.32796])
    expect(system.bbox).toEqual(bboxAround([-120.1832533, 39.327962], 5))
    expect(system.active).toBe(false)
  })

  it('ignores a previous entry with non-finite values', () => {
    const previous = { bbox: [Number.NaN, 0, 0, 0], center: [0, 0] }
    const result = buildEntry({ row: row('bcycle_truckee'), systemInformation: allSystemInformation.bcycle_truckee, stationInformation: truckeeInfo, previous, geocoded: null })
    expect(result.dropped).toMatch(/could not be geocoded/)
  })
})

describe('validateRegistry', () => {
  const good = { id: 'a', bbox: [-1, -1, 1, 1], center: [0, 0], stationCount: 2, active: true }

  it('accepts the committed registry', () => {
    expect(validateRegistry(registry)).toEqual([])
    expect(registry.every((s) => typeof s.active === 'boolean')).toBe(true)
  })

  it.each([
    ['a NaN bbox', { ...good, bbox: [Number.NaN, -1, 1, 1] }, /bbox is not 4 finite/],
    ['an Infinity center', { ...good, center: [Infinity, 0] }, /center is not 2 finite/],
    ['a null bbox', { ...good, bbox: null }, /bbox is not 4 finite/],
    ['an inverted bbox', { ...good, bbox: [1, -1, -1, 1] }, /inverted/],
    ['a center outside the bbox', { ...good, center: [5, 5] }, /outside/],
    ['active with 0 stations', { ...good, stationCount: 0 }, /active/],
  ])('rejects %s', (_label, entry, message) => {
    expect(validateRegistry([entry]).join('\n')).toMatch(message)
  })

  it('rejects duplicate ids', () => {
    expect(validateRegistry([good, good]).join('\n')).toMatch(/duplicate/)
  })
})

describe('getJson', () => {
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('sends the app User-Agent and returns the parsed body for 200', async () => {
    const fetchImpl = vi.fn(async () => ok({ a: 1 }))
    await expect(getJson('https://x.example/a.json', { fetchImpl })).resolves.toEqual({ status: 200, body: { a: 1 } })
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe(APP.userAgent)
  })

  it('returns the status without a body for non-200 responses', async () => {
    const fetchImpl = async () => new Response(JSON.stringify(bismarck404), { status: 404 })
    await expect(getJson('https://x.example/a.json', { fetchImpl })).resolves.toEqual({ status: 404, body: null })
  })

  it('retries a network failure once, then throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(getJson('https://x.example/a.json', { fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/fetch failed/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('probeSystem', () => {
  const feedsFor = (overrides = {}) => ({
    'https://gbfs.bcycle.com/bcycle_madison/gbfs.json': { status: 200, body: {} },
    'https://gbfs.bcycle.com/bcycle_madison/system_information.json': { status: 200, body: madisonSystemInformation },
    'https://gbfs.bcycle.com/bcycle_madison/station_information.json': { status: 200, body: madisonInfo },
    'https://gbfs.bcycle.com/bcycle_madison/station_status.json': { status: 200, body: {} },
    ...overrides,
  })
  const fakeFetch = (feeds) => vi.fn(async (url) => feeds[url] ?? { status: 404, body: null })

  it('builds the entry when every feed answers 200 (no geocoding)', async () => {
    const geocode = vi.fn()
    const result = await probeSystem(row('bcycle_madison'), undefined, { fetchJson: fakeFetch(feedsFor()), geocode })
    expect(result.system?.stationCount).toBe(111)
    expect(geocode).not.toHaveBeenCalled()
  })

  it('drops a system whose feeds are not HTTP 200 (bcycle_bismarck)', async () => {
    const result = await probeSystem(row('bcycle_bismarck'), { id: 'bcycle_bismarck', bbox: [0, 0, 1, 1], center: [0.5, 0.5] }, { fetchJson: fakeFetch({}) })
    expect(result).toEqual({ id: 'bcycle_bismarck', dropped: 'HTTP 404 for gbfs' })
    const statusMissing = feedsFor({ 'https://gbfs.bcycle.com/bcycle_madison/station_status.json': { status: 403, body: null } })
    expect((await probeSystem(row('bcycle_madison'), undefined, { fetchJson: fakeFetch(statusMissing) })).dropped).toBe('HTTP 403 for station_status')
  })

  it('geocodes the catalog Location once for a 0-station system without a previous entry', async () => {
    const feeds = {
      'https://gbfs.bcycle.com/bcycle_truckee/gbfs.json': { status: 200, body: {} },
      'https://gbfs.bcycle.com/bcycle_truckee/system_information.json': { status: 200, body: allSystemInformation.bcycle_truckee },
      'https://gbfs.bcycle.com/bcycle_truckee/station_information.json': { status: 200, body: truckeeInfo },
      'https://gbfs.bcycle.com/bcycle_truckee/station_status.json': { status: 200, body: { data: { stations: [] } } },
    }
    const geocode = vi.fn(async () => [-120.18, 39.33])
    const result = await probeSystem(row('bcycle_truckee', { location: 'Truckee, CA' }), undefined, { fetchJson: fakeFetch(feeds), geocode })
    expect(geocode).toHaveBeenCalledTimes(1)
    expect(geocode).toHaveBeenCalledWith('Truckee, CA')
    expect(result.system).toMatchObject({ active: false, stationCount: 0, center: [-120.18, 39.33] })

    geocode.mockClear()
    const previous = { bbox: [-120.2, 39.3, -120.1, 39.35], center: [-120.15, 39.32] }
    const again = await probeSystem(row('bcycle_truckee'), previous, { fetchJson: fakeFetch(feeds), geocode })
    expect(geocode).not.toHaveBeenCalled()
    expect(again.system?.center).toEqual(previous.center)
  })

  it('drops rows whose System ID does not match the feed path', async () => {
    const result = await probeSystem(row('bcycle_x', { discovery: 'https://gbfs.bcycle.com/bcycle_y/gbfs.json' }), undefined, { fetchJson: fakeFetch({}) })
    expect(result.dropped).toMatch(/does not match/)
  })
})

describe('createGeocoder', () => {
  it('queries Photon with the location and returns [lon, lat]', async () => {
    const fetchJson = vi.fn(async () => ({ status: 200, body: { features: [{ geometry: { coordinates: [-120.18, 39.33] } }] } }))
    const geocode = createGeocoder({ fetchJson, spacingMs: 0 })
    await expect(geocode('Truckee, CA')).resolves.toEqual([-120.18, 39.33])
    const url = new URL(fetchJson.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://photon.komoot.io/api/')
    expect(url.searchParams.get('q')).toBe('Truckee, CA')
    expect(url.searchParams.get('limit')).toBe('1')
  })

  it('returns null when nothing is found', async () => {
    const geocode = createGeocoder({ fetchJson: async () => ({ status: 200, body: { features: [] } }), spacingMs: 0 })
    await expect(geocode('Nowhere')).resolves.toBeNull()
  })
})

describe('mapPool', () => {
  it('keeps order and limits concurrency', async () => {
    let active = 0
    let peak = 0
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })
})
