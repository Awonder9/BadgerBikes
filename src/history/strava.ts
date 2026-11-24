// "Send to Strava" on the device: connecting (Strava's OAuth, back to this site with a code the Worker exchanges),
// keeping the tokens fresh, sending a ride and waiting for Strava to process it, and disconnecting. The tokens are
// kept on this device only (localStorage `bcycle.strava`), like everything else the app saves.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { api } from '../api/client'
import { ENDPOINTS, STRAVA } from '../config'
import type { Lang } from '../i18n/lang'
import { AppError, toAppError } from '../lib/errors'
import { safeStorage } from '../lib/storage'
import { useHistoryStore } from './historyStore'
import { rideSecondsOf, type RideRecord } from './rides'

export interface StravaAuth {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  athleteName: string | null
}

interface StravaState {
  auth: StravaAuth | null
  /** How the last return from Strava's connect page went (shown once in "Your rides"; not saved). */
  notice: ConnectResult | null
  setAuth(auth: StravaAuth | null): void
}

const TOKEN_RE = /^[A-Za-z0-9]{10,200}$/

/** Stored tokens (storage is untrusted), or null. */
export function validateAuth(v: unknown): StravaAuth | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as Record<string, unknown>
  if (typeof a.accessToken !== 'string' || !TOKEN_RE.test(a.accessToken) || typeof a.refreshToken !== 'string' || !TOKEN_RE.test(a.refreshToken)) return null
  if (typeof a.expiresAtMs !== 'number' || !Number.isFinite(a.expiresAtMs)) return null
  return { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAtMs: a.expiresAtMs, athleteName: typeof a.athleteName === 'string' ? a.athleteName.slice(0, 60) : null }
}

export const useStravaStore = create<StravaState>()(
  persist((set) => ({ auth: null, notice: null, setAuth: (auth) => set({ auth }) }), {
    name: 'bcycle.strava',
    version: 1,
    storage: createJSONStorage(() => safeStorage('local')),
    partialize: (s) => ({ auth: s.auth }),
    merge: (persisted, current) => ({ ...current, auth: validateAuth((persisted as { auth?: unknown } | null)?.auth) }),
  }),
)

// ─── Connecting ──────────────────────────────────────────────────────────────────────────────────

const OAUTH_KEY = 'bcycle.strava.oauth'
/** Query parameter of the redirect back from Strava (Strava adds code, state and scope, or error). */
export const CALLBACK_PARAM = 'strava'

/** Where Strava sends the rider back: this site's front page (the iOS/Android apps claim it too). */
export const redirectUri = (origin: string) => `${origin}/?${CALLBACK_PARAM}=callback`

/** Strava's authorization page for this device; remembers a random `state` to check on the way back. */
export function stravaConnectUrl(clientId: string, origin: string, nowMs = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  safeStorage('local').setItem(OAUTH_KEY, JSON.stringify({ state, atMs: nowMs }))
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(origin), response_type: 'code', approval_prompt: 'auto', scope: STRAVA.scope, state })
  return `${ENDPOINTS.strava}/oauth/authorize?${q.toString()}`
}

export interface StravaCallback {
  code: string | null
  state: string | null
  scope: string
  error: string | null
}

/** The redirect back from Strava in a query string, or null when this isn't one. */
export function parseStravaCallback(search: string): StravaCallback | null {
  const q = new URLSearchParams(search)
  if (q.get(CALLBACK_PARAM) !== 'callback') return null
  return { code: q.get('code'), state: q.get('state'), scope: q.get('scope') ?? '', error: q.get('error') }
}

/** The address without the callback's parameters (they are removed from the address bar once read). */
export function stripStravaCallback(href: string): string {
  const url = new URL(href)
  for (const k of [CALLBACK_PARAM, 'code', 'state', 'scope', 'error']) url.searchParams.delete(k)
  return url.pathname + url.search + url.hash
}

export type ConnectResult = 'connected' | 'denied' | 'noUploadPermission' | 'failed'

/**
 * Finishes connecting: the `state` must be the one this device sent (else it is someone else's link), the rider must
 * have allowed uploads (they can untick it on Strava's page), then the Worker exchanges the code.
 */
export async function finishStravaConnect(cb: StravaCallback, nowMs = Date.now()): Promise<ConnectResult> {
  const storage = safeStorage('local')
  let saved: { state?: unknown; atMs?: unknown } | null
  try {
    saved = JSON.parse(storage.getItem(OAUTH_KEY) ?? 'null') as { state?: unknown; atMs?: unknown } | null
  } catch {
    saved = null
  }
  storage.removeItem(OAUTH_KEY)
  if (cb.error) return 'denied'
  const fresh = saved && typeof saved.atMs === 'number' && nowMs - saved.atMs <= STRAVA.stateMaxAgeMs
  if (!cb.code || !cb.state || !fresh || saved?.state !== cb.state) return 'failed'
  if (!cb.scope.split(/[ ,]/).includes('activity:write')) return 'noUploadPermission'
  try {
    const t = await api.stravaToken({ code: cb.code })
    useStravaStore.getState().setAuth({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAtMs: t.expiresAtMs, athleteName: t.athleteName })
    return 'connected'
  } catch {
    return 'failed'
  }
}

/** An access token good for a while longer: refreshed when it expires soon. A revoked link disconnects. */
async function freshToken(nowMs = Date.now()): Promise<string> {
  const auth = useStravaStore.getState().auth
  if (!auth) throw new AppError('unauthorized', 'Not connected to Strava')
  if (auth.expiresAtMs - nowMs > STRAVA.refreshBeforeMs) return auth.accessToken
  try {
    const t = await api.stravaToken({ refreshToken: auth.refreshToken })
    useStravaStore.getState().setAuth({ ...auth, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAtMs: t.expiresAtMs })
    return t.accessToken
  } catch (e) {
    if (toAppError(e).code === 'unauthorized' || toAppError(e).code === 'bad_request') useStravaStore.getState().setAuth(null)
    throw e
  }
}

export async function disconnectStrava(): Promise<void> {
  const auth = useStravaStore.getState().auth
  useStravaStore.getState().setAuth(null)
  if (auth) await api.stravaRevoke(auth.refreshToken).catch(() => {})
}

// ─── Sending a ride ──────────────────────────────────────────────────────────────────────────────

export interface SendOptions {
  name: string
  description: string
  /** Riding time, seconds (the rider may correct an estimated one). */
  elapsedS: number
  commute: boolean
  lang: Lang
}

export type SendResult = { activityId: string; duplicate: boolean }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(id), reject(new AppError('aborted', 'Aborted'))), { once: true })
  })

/**
 * Sends `ride` as a Strava activity and waits until Strava has processed it. The ride remembers the activity (a duplicate
 * of one already on Strava counts as sent: it is that activity). Rejects with 'unauthorized' when the link was revoked
 * (the rider is disconnected), 'timeout' when Strava takes too long (it may still appear there).
 */
export async function sendToStrava(ride: RideRecord, opts: SendOptions, signal?: AbortSignal): Promise<SendResult> {
  if (!ride.line || ride.endedAtMs === null) throw new AppError('bad_request', 'This ride has no route to send')
  const accessToken = await freshToken()
  const { uploadId } = await api.stravaUpload(
    {
      accessToken,
      lang: opts.lang,
      polyline: ride.line,
      startedAtMs: Math.round(ride.startedAtMs),
      elapsedS: Math.max(60, Math.round(opts.elapsedS)),
      name: opts.name,
      description: opts.description,
      sportType: ride.electric ? 'EBikeRide' : 'Ride',
      commute: opts.commute,
      externalId: `badgerbikes-${ride.id}`,
    },
    signal,
  )
  for (let i = 0; i < STRAVA.maxPolls; i++) {
    await sleep(STRAVA.pollEveryMs, signal)
    const s = await api.stravaUploadStatus({ accessToken, uploadId }, signal)
    if ((s.state === 'ready' || s.state === 'duplicate') && s.activityId) {
      useHistoryStore.getState().update(ride.id, { stravaActivityId: s.activityId })
      return { activityId: s.activityId, duplicate: s.state === 'duplicate' }
    }
    if (s.state === 'error') throw new AppError('bad_response', 'Strava could not process the ride', { provider: 'strava' })
  }
  throw new AppError('timeout', 'Strava is still processing the ride', { provider: 'strava' })
}

/** The riding time to offer for a ride (its recorded time; the planned time while under way). */
export const defaultElapsedS = (ride: RideRecord): number => Math.round(rideSecondsOf(ride) || ride.plannedS)
