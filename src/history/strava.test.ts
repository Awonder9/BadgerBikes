import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetHttpState, setFetchImpl } from '../lib/http'
import { safeStorage } from '../lib/storage'
import { finishStravaConnect, parseStravaCallback, redirectUri, stravaConnectUrl, stripStravaCallback, useStravaStore, validateAuth } from './strava'

const NOW = 1_800_000_000_000

describe('connecting Strava', () => {
  let restore: (() => void) | null = null
  let tokenCalls = 0
  beforeEach(() => {
    resetHttpState()
    useStravaStore.setState({ auth: null, notice: null })
    tokenCalls = 0
    restore = setFetchImpl(async () => {
      tokenCalls++
      return new Response(JSON.stringify({ accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAtMs: NOW + 21_600_000, athleteName: 'Pat' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  })
  afterEach(() => restore?.())

  it('sends the rider to Strava with a fresh state, and back to the front page', () => {
    const url = new URL(stravaConnectUrl('12345', 'https://badgerbikes.app', NOW))
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri('https://badgerbikes.app'))
    expect(url.searchParams.get('scope')).toBe('read,activity:write')
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('finishes only with this device’s own, recent state and upload permission', async () => {
    const state = () => new URL(stravaConnectUrl('12345', 'https://x', NOW)).searchParams.get('state')!
    const cb = (s: string, scope = 'read,activity:write') => parseStravaCallback(`?strava=callback&state=${s}&code=abc123def456&scope=${scope}`)!
    expect(await finishStravaConnect(cb('forged'), NOW)).toBe('failed')
    expect(await finishStravaConnect(cb(state()), NOW + 60 * 60_000)).toBe('failed') // too old
    expect(await finishStravaConnect(cb(state(), 'read'), NOW)).toBe('noUploadPermission')
    expect(tokenCalls).toBe(0)
    const s = state()
    expect(await finishStravaConnect(cb(s), NOW)).toBe('connected')
    expect(useStravaStore.getState().auth).toMatchObject({ athleteName: 'Pat' })
    // The state is used once.
    expect(await finishStravaConnect(cb(s), NOW)).toBe('failed')
    expect(await finishStravaConnect(parseStravaCallback('?strava=callback&error=access_denied')!, NOW)).toBe('denied')
    expect(safeStorage('local').getItem('bcycle.strava.oauth')).toBeNull()
  })

  it('reads and strips the callback; validates stored tokens', () => {
    expect(parseStravaCallback('?start=1')).toBeNull()
    expect(stripStravaCallback('https://x/?strava=callback&state=s&code=c&scope=read&start=5')).toBe('/?start=5')
    expect(validateAuth({ accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAtMs: 1 })).toMatchObject({ athleteName: null })
    expect(validateAuth({ accessToken: '<script>', refreshToken: 'R'.repeat(40), expiresAtMs: 1 })).toBeNull()
  })
})
