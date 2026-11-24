// Strava for "Send to Strava": token exchange and refresh (they need the app's client secret, a Worker secret), the
// upload of a ride as a GPX file, its processing status, and disconnecting. Nothing is stored here: the rider's tokens
// live on their device and come with each request. Errors: 401 from Strava → 'unauthorized' (connect again).
import { ENDPOINTS } from '../src/config'
import type { StravaTokenResponse, StravaUploadRequest, StravaUploadStatusResponse } from '../src/api/contract'
import { decodePolyline } from '../src/lib/polyline'
import { AppError } from '../src/lib/errors'
import type { UpstreamFetch, UpstreamRequest } from '../src/lib/upstream'
import { MESSAGES } from '../src/i18n'
import { stravaGpx } from '../src/history/stravaGpx'

export interface StravaSecrets {
  STRAVA_CLIENT_ID?: string
  STRAVA_CLIENT_SECRET?: string
}

export interface StravaApp {
  clientId: string
  clientSecret: string
}

/** The deployment's Strava app, or null (the feature is hidden: /api/meta reports no client id). */
export function stravaAppFrom(env: StravaSecrets): StravaApp | null {
  const clientId = env.STRAVA_CLIENT_ID?.trim()
  const clientSecret = env.STRAVA_CLIENT_SECRET?.trim()
  return clientId && /^\d{1,12}$/.test(clientId) && clientSecret ? { clientId, clientSecret } : null
}

const base = (req: Omit<UpstreamRequest, 'group' | 'priority' | 'provider'>, signal?: AbortSignal): UpstreamRequest => ({
  ...req,
  group: 'strava',
  priority: 'interactive',
  provider: 'strava',
  signal,
})

/** Strava's 401 (token revoked or expired) as our own error, so the app asks the rider to connect again. */
function mapError(err: unknown): never {
  if (err instanceof AppError && err.status === 401) throw new AppError('unauthorized', 'Strava access was revoked or expired.', { status: 401, provider: 'strava' })
  if (err instanceof AppError && err.code === 'http' && err.status !== undefined && err.status < 500)
    throw new AppError('bad_request', 'Strava refused the request.', { status: err.status, provider: 'strava', body: err.body })
  throw err
}

interface RawToken {
  access_token?: unknown
  refresh_token?: unknown
  expires_at?: unknown
  scope?: unknown
  athlete?: { firstname?: unknown } | null
}

/** Exchanges an authorization code, or refreshes with a refresh token. */
export async function stravaToken(up: UpstreamFetch, app: StravaApp, grant: { code: string } | { refreshToken: string }, signal?: AbortSignal): Promise<StravaTokenResponse> {
  const form: Record<string, string> = { client_id: app.clientId, client_secret: app.clientSecret }
  if ('code' in grant) Object.assign(form, { grant_type: 'authorization_code', code: grant.code })
  else Object.assign(form, { grant_type: 'refresh_token', refresh_token: grant.refreshToken })
  let raw: RawToken
  try {
    raw = await up<RawToken>(base({ url: `${ENDPOINTS.strava}/api/v3/oauth/token`, method: 'POST', form }, signal))
  } catch (e) {
    mapError(e)
  }
  if (typeof raw.access_token !== 'string' || typeof raw.refresh_token !== 'string' || typeof raw.expires_at !== 'number') throw new AppError('bad_response', 'Strava token response', { provider: 'strava' })
  const first = raw.athlete && typeof raw.athlete.firstname === 'string' ? raw.athlete.firstname.slice(0, 60) : null
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAtMs: raw.expires_at * 1000,
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    athleteName: first,
  }
}

/** Uploads the ride (GPX built here, with the "planned route" note in the rider's language). Returns the upload id. */
export async function stravaUpload(up: UpstreamFetch, req: StravaUploadRequest, signal?: AbortSignal): Promise<string> {
  const note = MESSAGES[req.lang].strava.plannedNote
  const description = [req.description.trim(), note].filter(Boolean).join('\n\n')
  const gpx = stravaGpx({ name: req.name, line: decodePolyline(req.polyline, 6), startedAtMs: req.startedAtMs, elapsedS: req.elapsedS })
  const multipart: NonNullable<UpstreamRequest['multipart']> = [
    { name: 'file', value: gpx, fileName: `${req.externalId}.gpx`, type: 'application/gpx+xml' },
    { name: 'data_type', value: 'gpx' },
    { name: 'sport_type', value: req.sportType },
    { name: 'name', value: req.name },
    { name: 'description', value: description },
    { name: 'external_id', value: req.externalId },
    ...(req.commute ? [{ name: 'commute', value: '1' }] : []),
  ]
  try {
    const res = await up<{ id_str?: unknown; id?: unknown; error?: unknown }>(base({ url: `${ENDPOINTS.strava}/api/v3/uploads`, method: 'POST', multipart, headers: { Authorization: `Bearer ${req.accessToken}` } }, signal))
    const id = typeof res.id_str === 'string' ? res.id_str : typeof res.id === 'number' ? String(res.id) : null
    if (!id) throw new AppError('bad_response', 'Strava upload response', { provider: 'strava' })
    return id
  } catch (e) {
    return mapError(e)
  }
}

/** Where an upload is: still processing, done (with its activity), a duplicate of an existing activity, or failed. */
export async function stravaUploadStatus(up: UpstreamFetch, accessToken: string, uploadId: string, signal?: AbortSignal): Promise<StravaUploadStatusResponse> {
  let res: { activity_id?: unknown; error?: unknown }
  try {
    res = await up(base({ url: `${ENDPOINTS.strava}/api/v3/uploads/${uploadId}`, headers: { Authorization: `Bearer ${accessToken}` } }, signal))
  } catch (e) {
    mapError(e)
  }
  return uploadState(res)
}

/** Strava's upload object → our status (pure; Strava's status strings aren't relied on). */
export function uploadState(res: { activity_id?: unknown; error?: unknown }): StravaUploadStatusResponse {
  const activityId = typeof res.activity_id === 'number' || (typeof res.activity_id === 'string' && /^\d+$/.test(res.activity_id)) ? String(res.activity_id) : null
  if (activityId) return { state: 'ready', activityId }
  if (typeof res.error === 'string' && res.error) {
    // "x.gpx duplicate of activity 21234316"
    const dup = /duplicate of(?: activity)?\s+(\d+)/i.exec(res.error)
    return dup ? { state: 'duplicate', activityId: dup[1]! } : { state: 'error', activityId: null }
  }
  return { state: 'processing', activityId: null }
}

/** Disconnects the app from the rider's Strava account (their tokens stop working). */
export async function stravaRevoke(up: UpstreamFetch, app: StravaApp, token: string, signal?: AbortSignal): Promise<void> {
  try {
    await up(
      base(
        {
          url: `${ENDPOINTS.strava}/oauth/revoke`,
          method: 'POST',
          form: { token },
          headers: { Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}` },
        },
        signal,
      ),
    )
  } catch (e) {
    // Already revoked or expired: disconnected either way.
    if (e instanceof AppError && (e.status === 400 || e.status === 401)) return
    mapError(e)
  }
}
