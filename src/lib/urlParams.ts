// Untrusted input from the URL and from feeds: launch parameters, share links and external links.
import { isValidLngLat } from './geo'
import type { LngLat } from '../types'

export interface SharedPoint {
  coord: LngLat
  name: string | null
}

export interface LaunchParams {
  /** Valid registry id, or null. */
  systemId: string | null
  stationId: string | null
  /** Shared ride: start dock, destination (a place, or a dock via `toStation`) and route option. */
  rideStartId: string | null
  to: SharedPoint | null
  toStationId: string | null
  /** 0 = bike-friendly, 1 = balanced, 2 = fastest. */
  routeIndex: number | null
}

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/
const MAX_NAME = 80

function parseId(raw: string | null): string | null {
  if (raw === null) return null
  const v = raw.trim()
  return ID_RE.test(v) ? v : null
}

/** "lat,lon" (human order in URLs) → [lon, lat], 6 dp max. */
export function parseLatLon(raw: string | null): LngLat | null {
  if (!raw) return null
  const m = /^\s*(-?\d{1,2}(?:\.\d{1,8})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,8})?)\s*$/.exec(raw)
  if (!m) return null
  const coord: LngLat = [Number(m[2]), Number(m[1])]
  return isValidLngLat(coord) ? coord : null
}

export function formatLatLon(coord: LngLat): string {
  return `${coord[1].toFixed(6)},${coord[0].toFixed(6)}`
}

function parseName(raw: string | null): string | null {
  if (!raw) return null
  // Share links write spaces as "_" (see buildRideShareUrl); older links used "+", which arrives as a space.
  // Drop control characters and angle brackets; this text is only ever rendered as React text.
  const v = Array.from(raw.replace(/_/g, ' '))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0
      return c >= 0x20 && c !== 0x7f && ch !== '<' && ch !== '>'
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
  return v || null
}

export function parseLaunchParams(search: string, knownSystemIds: ReadonlySet<string>): LaunchParams {
  const q = new URLSearchParams(search)
  const system = parseId(q.get('system'))
  const toCoord = parseLatLon(q.get('to'))
  const route = q.get('route')
  return {
    systemId: system && knownSystemIds.has(system) ? system : null,
    stationId: parseId(q.get('station')),
    rideStartId: parseId(q.get('start')),
    to: toCoord ? { coord: toCoord, name: parseName(q.get('toName')) } : null,
    toStationId: parseId(q.get('toStation')),
    routeIndex: route !== null && /^[0-2]$/.test(route) ? Number(route) : null,
  }
}

/** Params consumed at launch and removed from the address bar afterwards. */
export const LAUNCH_PARAM_KEYS = ['system', 'station', 'start', 'to', 'toName', 'toStation', 'route'] as const

export function stripLaunchParams(href: string): string {
  const url = new URL(href)
  for (const k of LAUNCH_PARAM_KEYS) url.searchParams.delete(k)
  return url.pathname + (url.search ? url.search : '') + url.hash
}

export interface RideShareState {
  systemId: string
  startId: string
  to: SharedPoint
  toStationId?: string | null
  routeIndex?: number
}

/** A place name for a share link: no spaces at all ("_" instead), so no chat app or linkifier can split the link there. */
function shareName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).replace(/ /g, '_')
}

/**
 * Builds a ride share link that parseLaunchParams reads back. The name goes before the coordinates, so the link
 * always ends in a number or an id: linkifiers drop a trailing "." or ")" that a name could end with.
 */
export function buildRideShareUrl(origin: string, state: RideShareState): string {
  const url = new URL('/', origin)
  url.searchParams.set('system', state.systemId)
  url.searchParams.set('start', state.startId)
  const name = state.to.name ? shareName(state.to.name) : ''
  if (name) url.searchParams.set('toName', name)
  url.searchParams.set('to', formatLatLon(state.to.coord))
  if (state.toStationId) url.searchParams.set('toStation', state.toStationId)
  if (state.routeIndex) url.searchParams.set('route', String(state.routeIndex))
  return url.toString()
}

/** A link that opens the app on a station's card (read back by parseLaunchParams). */
export function buildStationShareUrl(origin: string, systemId: string, stationId: string): string {
  const url = new URL('/', origin)
  url.searchParams.set('system', systemId)
  url.searchParams.set('station', stationId)
  return url.toString()
}

/** Host allow-lists for links built from feed data. */
export const LINK_HOSTS = {
  bcycle: ['bcycle.com'],
  appStores: ['apps.apple.com', 'play.google.com'],
  osm: ['openstreetmap.org'],
} as const

/**
 * Returns a safe https URL string, or null. The host must equal an allowed host or be a subdomain of
 * one. Pass `allowHosts: null` to accept any https host (e.g. a system's own website from the feed).
 */
export function safeExternalUrl(raw: string | null | undefined, allowHosts: readonly string[] | null): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (allowHosts && !allowHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null
  return url.toString()
}

/** The only custom scheme the app opens: the BCycle app's discovery URI from system_information. */
export function safeAppDiscoveryUri(raw: string | null | undefined): string | null {
  if (!raw) return null
  return /^bcycle:\/\/[A-Za-z0-9/_?=&.-]*$/.test(raw.trim()) ? raw.trim() : null
}

/**
 * The link behind "Open BCycle".
 * iOS: the BCycle app no longer answers its `bcycle://` scheme (Safari: "address is invalid") and its web
 * links don't open the app, so this opens the app's App Store page in the App Store app (`itms-apps://`),
 * which shows "Open" when it is installed and "Get" when it isn't. Never an error page.
 * Android: an intent:// link that launches the app by its package (from the Play Store URL), with the
 * store page as fallback when it isn't installed.
 */
export function appLaunchUrl(platform: 'ios' | 'android', discoveryUri: string | null, storeUri: string | null): string | null {
  if (platform === 'ios') {
    const id = storeUri ? /^https:\/\/apps\.apple\.com\/.*\/id(\d{3,15})(?:[/?#]|$)/.exec(storeUri)?.[1] : undefined
    return id ? `itms-apps://apps.apple.com/app/id${id}` : null
  }
  // Android: launch the installed app by package (its home screen), like tapping its icon — this needs
  // no link support from the app. Falls back to the Play Store page when it isn't installed.
  const pkg = storeUri ? new URL(storeUri).searchParams.get('id') : null
  if (!pkg || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) return safeAppDiscoveryUri(discoveryUri)
  const fallback = storeUri ? `S.browser_fallback_url=${encodeURIComponent(storeUri)};` : ''
  return `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${pkg};${fallback}end`
}
