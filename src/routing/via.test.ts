import { describe, expect, it } from 'vitest'
import { AppError } from '../lib/errors'
import type { UpstreamRequest } from '../lib/upstream'
import { createRouter } from './index'
import { routeBody } from './valhalla'
import type { RouteRequest } from './types'

const req: RouteRequest = { role: 'ride', mode: 'bike', from: [-89.38, 43.07], to: [-89.38, 43.07], units: 'imperial', language: 'en-US' }

describe('routes through via points ("Just ride")', () => {
  it('sends them to Valhalla as through locations between the ends, a synthesized one with a wider snap', () => {
    const body = routeBody({ ...req, via: [{ coord: [-89.4, 43.08] }, { coord: [-89.39, 43.06], searchCutoffMeters: 1500 }] }) as { locations: Array<Record<string, unknown>> }
    expect(body.locations).toEqual([
      { lat: 43.07, lon: -89.38 },
      { lat: 43.08, lon: -89.4, type: 'through' },
      { lat: 43.06, lon: -89.39, type: 'through', search_cutoff: 1500 },
      { lat: 43.07, lon: -89.38 },
    ])
    expect((routeBody(req) as { locations: unknown[] }).locations).toHaveLength(2)
  })

  it('never falls back to OSRM (it would stop at each point), and caches per via list', async () => {
    const asked: UpstreamRequest[] = []
    const up = async <T,>(r: UpstreamRequest): Promise<T> => {
      asked.push(r)
      throw new AppError('http', 'down', { status: 500 })
    }
    const router = createRouter({ upstream: up })
    await expect(router.routeLadder({ ...req, via: [{ coord: [-89.4, 43.08] }] }, [0])).rejects.toMatchObject({ code: 'upstream_unavailable' })
    expect(asked.map((r) => r.provider)).toEqual(['valhalla'])
    expect(asked[0]!.cacheKey).toContain('via:-89.40000,43.08000')
    asked.length = 0
    await expect(router.routeLadder(req, [0])).rejects.toMatchObject({ code: 'upstream_unavailable' })
    expect(asked.map((r) => r.provider)).toEqual(['valhalla', 'osrm'])
  })
})
