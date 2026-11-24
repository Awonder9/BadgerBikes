import { describe, expect, it } from 'vitest'
import { STRAVA } from '../src/config'
import { AppError } from '../src/lib/errors'
import { encodePolyline } from '../src/lib/polyline'
import type { UpstreamRequest } from '../src/lib/upstream'
import { MESSAGES } from '../src/i18n'
import { stravaGpx } from '../src/history/stravaGpx'
import { createApp, type AppDeps } from './app'
import { stravaAppFrom, uploadState } from './strava'

const NOW = 1_800_000_000_000
const token = 'a'.repeat(40)
const polyline = encodePolyline([[-89.3842, 43.07467], [-89.39, 43.075], [-89.4003, 43.07652]], 6)

function appWith(answer: (r: UpstreamRequest) => unknown, strava: AppDeps['strava'] = { clientId: '12345', clientSecret: 'shh' }) {
  const asked: UpstreamRequest[] = []
  const app = createApp({
    upstream: (async (r: UpstreamRequest) => {
      asked.push(r)
      return answer(r)
    }) as never,
    createRouter: () => ({}) as never,
    fetchStationsSnapshot: async () => ({}) as never,
    fetchSystemDetails: async () => ({}) as never,
    searchPlaces: async () => [],
    reversePlace: async () => null,
    fetchWeather: async () => ({}) as never,
    now: () => NOW,
    contactEmail: null,
    version: 'test',
    strava,
  })
  const post = (path: string, body: unknown) => app.fetch(new Request(`https://x.test${path}`, { method: 'POST', body: JSON.stringify(body) }))
  return { app, asked, post }
}

const upload = (o: Record<string, unknown> = {}) => ({
  accessToken: token,
  lang: 'en',
  polyline,
  startedAtMs: NOW - 3_600_000,
  elapsedS: 900,
  name: 'Bike-share ride: Capitol → Memorial Union',
  description: 'Nice <b>day</b>',
  sportType: 'EBikeRide',
  commute: true,
  externalId: 'badgerbikes-abc-1',
  ...o,
})

describe('Strava', () => {
  it('is set up only with a numeric client id and a secret; /api/meta tells the app', async () => {
    expect(stravaAppFrom({ STRAVA_CLIENT_ID: '12345', STRAVA_CLIENT_SECRET: 's' })).toEqual({ clientId: '12345', clientSecret: 's' })
    expect(stravaAppFrom({ STRAVA_CLIENT_ID: 'abc', STRAVA_CLIENT_SECRET: 's' })).toBeNull()
    expect(stravaAppFrom({})).toBeNull()
    const on = appWith(() => ({}))
    expect(await (await on.app.fetch(new Request('https://x.test/api/meta'))).json()).toMatchObject({ stravaClientId: '12345' })
    const off = appWith(() => ({}), null)
    expect(await (await off.app.fetch(new Request('https://x.test/api/meta'))).json()).toMatchObject({ stravaClientId: null })
    expect((await off.post('/api/strava/token', { code: 'abcdefghij' })).status).toBe(404)
  })

  it('exchanges a code with the client secret added here, never stored', async () => {
    const { asked, post } = appWith(() => ({ access_token: 'A'.repeat(40), refresh_token: 'R'.repeat(40), expires_at: 1_800_021_600, athlete: { firstname: 'Pat' } }))
    const res = await post('/api/strava/token', { code: 'abcdef0123456789' })
    expect(await res.json()).toEqual({ accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAtMs: 1_800_021_600_000, athleteName: 'Pat' })
    expect(asked[0]).toMatchObject({ url: 'https://www.strava.com/api/v3/oauth/token', method: 'POST', group: 'strava', form: { client_id: '12345', client_secret: 'shh', grant_type: 'authorization_code', code: 'abcdef0123456789' } })
    expect(asked[0]!.cacheKey).toBeUndefined()
    await post('/api/strava/token', { refreshToken: 'R'.repeat(40) })
    expect(asked[1]!.form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'R'.repeat(40) })
    expect((await post('/api/strava/token', { code: 'bad code!' })).status).toBe(400)
  })

  it('turns Strava’s 401 into "connect again"', async () => {
    const { post } = appWith(() => {
      throw new AppError('http', 'HTTP 401', { status: 401 })
    })
    const res = await post('/api/strava/token', { refreshToken: 'R'.repeat(40) })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('uploads a GPX it builds itself, with the planned-route note in the rider’s language', async () => {
    const { asked, post } = appWith(() => ({ id_str: '987654321012', error: null, activity_id: null }))
    const res = await post('/api/strava/upload', upload({ lang: 'zh-Hans' }))
    expect(await res.json()).toEqual({ uploadId: '987654321012' })
    const r = asked[0]!
    expect(r).toMatchObject({ url: 'https://www.strava.com/api/v3/uploads', method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    const field = (name: string) => r.multipart!.find((f) => f.name === name)
    expect(field('sport_type')?.value).toBe('EBikeRide')
    expect(field('commute')?.value).toBe('1')
    expect(field('external_id')?.value).toBe('badgerbikes-abc-1')
    expect(field('data_type')?.value).toBe('gpx')
    // The rider's text is cleaned; the note is always there and can't be left out.
    expect(field('description')?.value).toBe(`Nice bday/b\n\n${MESSAGES['zh-Hans'].strava.plannedNote}`)
    const gpx = field('file')!.value
    expect(field('file')!.fileName).toBe('badgerbikes-abc-1.gpx')
    expect(gpx.match(/<time>/g)).toHaveLength(4) // metadata + 3 points
    expect(gpx).toContain(new Date(NOW - 3_600_000 + 900_000).toISOString().replace('.000Z', 'Z'))
  })

  it('refuses implausible uploads', async () => {
    const { post, asked } = appWith(() => ({}))
    for (const o of [{ elapsedS: 10 }, { elapsedS: 13 * 3600 }, { startedAtMs: NOW + 3_600_000 }, { externalId: 'other-1' }, { name: '  ' }, { polyline: '!' }, { accessToken: 'x' }, { lang: 'fr' }]) {
      expect((await post('/api/strava/upload', upload(o))).status).toBe(400)
    }
    expect(asked).toHaveLength(0)
  })

  it('reads an upload’s state without trusting Strava’s status text', async () => {
    expect(uploadState({ activity_id: 123, error: null })).toEqual({ state: 'ready', activityId: '123' })
    expect(uploadState({ activity_id: null, error: null })).toEqual({ state: 'processing', activityId: null })
    expect(uploadState({ activity_id: null, error: 'badgerbikes-abc-1.gpx duplicate of activity 21234316' })).toEqual({ state: 'duplicate', activityId: '21234316' })
    expect(uploadState({ activity_id: null, error: 'Something broke' })).toEqual({ state: 'error', activityId: null })
    const { post, asked } = appWith(() => ({ activity_id: 5, error: null }))
    expect(await (await post('/api/strava/upload-status', { accessToken: token, uploadId: '987654321012' })).json()).toEqual({ state: 'ready', activityId: '5' })
    expect(asked[0]!.url).toBe('https://www.strava.com/api/v3/uploads/987654321012')
    expect((await post('/api/strava/upload-status', { accessToken: token, uploadId: '../x' })).status).toBe(400)
  })

  it('disconnects with the app’s credentials; an already-dead token is fine', async () => {
    const { post, asked } = appWith(() => {
      throw new AppError('http', 'HTTP 401', { status: 401 })
    })
    expect((await post('/api/strava/revoke', { token })).status).toBe(200)
    expect(asked[0]).toMatchObject({ url: 'https://www.strava.com/oauth/revoke', form: { token }, headers: { Authorization: `Basic ${btoa('12345:shh')}` } })
  })
})

describe('stravaGpx', () => {
  it('spreads times along the line by distance and escapes the name', () => {
    const gpx = stravaGpx({ name: 'A & B', line: [[0, 0], [0, 0.001], [0, 0.003]], startedAtMs: Date.UTC(2026, 10, 24, 12), elapsedS: 300 })
    expect(gpx).toContain('<name>A &amp; B</name>')
    expect([...gpx.matchAll(/<trkpt[^>]*><time>([^<]+)<\/time>/g)].map((m) => m[1])).toEqual(['2026-11-24T12:00:00Z', '2026-11-24T12:01:40Z', '2026-11-24T12:05:00Z'])
  })
})

it('keeps Strava’s name limits in config', () => {
  expect(STRAVA.maxNameLength).toBeGreaterThan(20)
})
