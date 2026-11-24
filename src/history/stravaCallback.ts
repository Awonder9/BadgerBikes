// Strava's redirect back to this site after "Connect with Strava" (?strava=callback&code&state&scope, or error): reading
// it and removing it from the address bar. Tiny on purpose: the app checks every launch for it, while the rest of
// "Send to Strava" (src/history/strava.ts) loads only when needed. Pure: no DOM, no storage.

/** Query parameter of the redirect back from Strava (Strava adds code, state and scope, or error). */
export const CALLBACK_PARAM = 'strava'

/** Where Strava sends the rider back: this site's front page (the iOS/Android apps claim it too). */
export const redirectUri = (origin: string) => `${origin}/?${CALLBACK_PARAM}=callback`

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
