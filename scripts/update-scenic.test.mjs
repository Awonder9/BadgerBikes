import { describe, expect, it } from 'vitest'
import { APP, SCENIC as APP_SCENIC } from '../src/config'
import { parseScenic } from '../src/routing/scenic'
import { cityBikeTrail, haversine, overpassQuery, padBbox, sampleLine, SCENIC, summarize, USER_AGENT } from './update-scenic.mjs'

const geom = (coords) => coords.map(([lon, lat]) => ({ lon, lat }))

describe('update-scenic', () => {
  it('keeps its copies of app constants in step', () => {
    expect(USER_AGENT).toBe(APP.userAgent)
    const { requestTimeoutMs: _r, ...shared } = APP_SCENIC
    expect(SCENIC).toEqual(shared)
  })

  it('asks Overpass for one padded city box (south, west, north, east)', () => {
    const box = padBbox([-89.5, 43.0, -89.3, 43.1], 1000)
    expect(box[0]).toBeLessThan(-89.5)
    expect(box[3]).toBeGreaterThan(43.1)
    const q = overpassQuery([-89.5, 43.0, -89.3, 43.1], 25)
    expect(q).toContain('[out:json][timeout:25]')
    expect(q).toContain('(43.00000,-89.50000,43.10000,-89.30000)')
    expect(q).toContain('"tourism"="viewpoint"')
  })

  it('samples a line evenly, skipping stubs', () => {
    const line = [[-89.4, 43.0], [-89.4, 43.01]] // ~1.1 km
    const pts = sampleLine(line, 350, 120)
    expect(pts).toHaveLength(3)
    expect(haversine(pts[0], pts[1])).toBeCloseTo(1112 / 3, -1)
    expect(sampleLine([[-89.4, 43.0], [-89.4, 43.0005]], 350, 120)).toEqual([])
  })

  it('leaves out trails a city bike does not belong on', () => {
    expect(cityBikeTrail({ highway: 'cycleway' }, 'Capital City Trail')).toBe(true)
    expect(cityBikeTrail({ highway: 'path', 'mtb:scale': '1' }, '')).toBe(false)
    expect(cityBikeTrail({ highway: 'path' }, 'Seminole Mountain Bike Trail')).toBe(false)
    expect(cityBikeTrail({ highway: 'path', surface: 'dirt' }, '')).toBe(false)
    expect(cityBikeTrail({ highway: 'track' }, '')).toBe(false)
  })

  it('scores trail points by the scenery near them and names the best feature', () => {
    const json = {
      elements: [
        // A named lakeside path through a park, with a viewpoint at its east end.
        { type: 'way', tags: { highway: 'cycleway', name: 'Lakeshore Path' }, geometry: geom([[-89.42, 43.075], [-89.40, 43.075]]) },
        // An unnamed path far from anything.
        { type: 'way', tags: { highway: 'cycleway' }, geometry: geom([[-89.30, 43.0], [-89.29, 43.0]]) },
        { type: 'way', tags: { highway: 'path', 'mtb:scale': '2', name: 'Singletrack' }, geometry: geom([[-89.35, 43.0], [-89.34, 43.0]]) },
        // The shore runs along the path's east end only.
        { type: 'way', tags: { natural: 'water', name: 'Lake Mendota' }, geometry: geom([[-89.404, 43.076], [-89.40, 43.076]]) },
        { type: 'way', tags: { leisure: 'park', name: 'Picnic Point' }, bounds: { minlon: -89.425, minlat: 43.07, maxlon: -89.41, maxlat: 43.08 } },
        { type: 'node', lon: -89.401, lat: 43.0752, tags: { tourism: 'viewpoint' } },
      ],
    }
    const data = summarize(json, 'bcycle_madison', '2026-11-24')
    expect(data).toMatchObject({ v: 1, systemId: 'bcycle_madison', generatedOn: '2026-11-24' })
    expect(data.trails).toEqual(['Lakeshore Path'])
    const points = parseScenic(data)
    // Best first: east end (viewpoint + water + named) beats the park stretch, which beats the plain path.
    expect(points[0]).toMatchObject({ trail: 'Lakeshore Path', place: { kind: 'viewpoint', name: '' } })
    expect(points[0].score).toBe(1 + SCENIC.score.namedRoute + SCENIC.score.viewpoint + SCENIC.score.water)
    expect(points.some((p) => p.place?.name === 'Picnic Point')).toBe(true)
    expect(points.at(-1)).toMatchObject({ score: 1, trail: null, place: null })
    // Nothing from the singletrack.
    expect(points.every((p) => p.coord[0] < -89.36 || p.coord[0] > -89.33)).toBe(true)
  })
})
