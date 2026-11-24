import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetHttpState, setFetchImpl } from '../lib/http'
import { safeStorage } from '../lib/storage'
import { disconnectStrava, finishStravaConnect, freshToken, parseStravaCallback, redirectUri, stravaConnectUrl, stripStravaCallback, useStravaStore, validateAuth } from './strava'

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

  it('refreshes once for two sends at the same time (a refresh spends the refresh token the other would use)', async () => {
    useStravaStore.setState({ auth: { accessToken: 'O'.repeat(40), refreshToken: 'P'.repeat(40), expiresAtMs: NOW + 60_000, athleteName: 'Pat' } })
    const tokens = await Promise.all([freshToken(NOW), freshToken(NOW)])
    expect(tokens).toEqual(['A'.repeat(40), 'A'.repeat(40)])
    expect(tokenCalls).toBe(1)
    expect(useStravaStore.getState().auth).toMatchObject({ refreshToken: 'R'.repeat(40), expiresAtMs: NOW + 21_600_000 })
  })

  it('uses the newer tokens another tab stored instead of refreshing again', async () => {
    useStravaStore.setState({ auth: { accessToken: 'O'.repeat(40), refreshToken: 'P'.repeat(40), expiresAtMs: NOW + 60_000, athleteName: 'Pat' } })
    // The other tab refreshed: its tokens are in storage, this tab still holds the spent ones.
    safeStorage('local').setItem('bcycle.strava', JSON.stringify({ state: { auth: { accessToken: 'N'.repeat(40), refreshToken: 'Q'.repeat(40), expiresAtMs: NOW + 3_600_000, athleteName: 'Pat' } }, version: 1 }))
    expect(await freshToken(NOW)).toBe('N'.repeat(40))
    expect(tokenCalls).toBe(0)
  })

  it('a refused refresh disconnects; one refused because another tab refreshed first does not', async () => {
    restore?.()
    restore = setFetchImpl(async () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Strava refused the request.', retryable: false } }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const spent = { accessToken: 'O'.repeat(40), refreshToken: 'P'.repeat(40), expiresAtMs: NOW + 60_000, athleteName: 'Pat' }
    useStravaStore.setState({ auth: spent })
    await expect(freshToken(NOW)).rejects.toMatchObject({ code: 'bad_request' })
    expect(useStravaStore.getState().auth).toBeNull()

    useStravaStore.setState({ auth: spent })
    // While this tab's refresh is on its way, another tab's lands in storage.
    restore()
    restore = setFetchImpl(async () => {
      safeStorage('local').setItem('bcycle.strava', JSON.stringify({ state: { auth: { ...spent, accessToken: 'N'.repeat(40), refreshToken: 'Q'.repeat(40), expiresAtMs: NOW + 3_600_000 } }, version: 1 }))
      return new Response(JSON.stringify({ error: { code: 'bad_request', message: 'x', retryable: false } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })
    expect(await freshToken(NOW)).toBe('N'.repeat(40))
    expect(useStravaStore.getState().auth).toMatchObject({ refreshToken: 'Q'.repeat(40) })
  })

  it('a refresh that comes back after Disconnect neither reconnects nor leaves the new token valid', async () => {
    const revoked: string[] = []
    let answer: (() => void) | null = null
    restore?.()
    restore = setFetchImpl(async (url, init) => {
      if (String(url).endsWith('/api/strava/revoke')) {
        revoked.push((JSON.parse(String(init?.body)) as { token: string }).token)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      await new Promise<void>((r) => (answer = r))
      return new Response(JSON.stringify({ accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAtMs: NOW + 21_600_000, athleteName: 'Pat' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    useStravaStore.setState({ auth: { accessToken: 'O'.repeat(40), refreshToken: 'P'.repeat(40), expiresAtMs: NOW + 60_000, athleteName: 'Pat' } })
    const pending = freshToken(NOW)
    await vi.waitFor(() => expect(answer).not.toBeNull())
    await disconnectStrava()
    answer!()
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    expect(useStravaStore.getState().auth).toBeNull()
    await vi.waitFor(() => expect(revoked).toEqual(['P'.repeat(40), 'R'.repeat(40)]))
  })

  it('reads and strips the callback; validates stored tokens', () => {
    expect(parseStravaCallback('?start=1')).toBeNull()
    expect(stripStravaCallback('https://x/?strava=callback&state=s&code=c&scope=read&start=5')).toBe('/?start=5')
    expect(validateAuth({ accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAtMs: 1 })).toMatchObject({ athleteName: null })
    expect(validateAuth({ accessToken: '<script>', refreshToken: 'R'.repeat(40), expiresAtMs: 1 })).toBeNull()
  })
})
