// Where the rider's position comes from: the browser's Geolocation API, or inside the iOS/Android apps the native
// location plugin. The apps never use their web view's own API: on iPhone it asks twice (the app's prompt, then
// WebKit's "“localhost” Would Like to Use Your Current Location", again every day), and only the plugin can tell
// whether location is allowed without asking.
import { LOCATION } from '../config'
import { nativePlugins } from '../native'
import type { GeoFix } from '../types'
import { isNativeApp } from '../ui/platform'

export type GeoErrorCode = 'geo_denied' | 'geo_unavailable' | 'geo_timeout' | 'geo_unsupported'

/** Watches the position until the returned function is called. */
export interface GeoSource {
  watch(onFix: (fix: GeoFix) => void, onError: (code: GeoErrorCode) => void): () => void
}

/** A position from the browser or the plugin (the plugin reports the same shape). */
interface PositionLike {
  timestamp: number
  coords: { latitude: number; longitude: number; accuracy: number; heading: number | null; speed: number | null }
}

export function toGeoFix(pos: PositionLike): GeoFix {
  const c = pos.coords
  const num = (v: number | null) => (v === null || Number.isNaN(v) || v < 0 ? null : v)
  return { coord: [c.longitude, c.latitude], accuracy: c.accuracy, heading: num(c.heading), speed: num(c.speed), timestampMs: pos.timestamp }
}

const BROWSER_ERRORS: Record<number, GeoErrorCode> = { 1: 'geo_denied', 2: 'geo_unavailable', 3: 'geo_timeout' }

/**
 * The location plugin's error codes (OS-PLUG-GLOC-…) as the app's errors. Location turned off for the whole phone,
 * or the rider declining Android's offer to turn it on, counts as denied, as it does in Safari.
 */
export function nativeGeoError(err: unknown): GeoErrorCode {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
  switch (code) {
    case 'OS-PLUG-GLOC-0003': // permission denied
    case 'OS-PLUG-GLOC-0007': // location services off
    case 'OS-PLUG-GLOC-0008': // restricted (Screen Time, device management)
    case 'OS-PLUG-GLOC-0009': // the rider declined turning location on
      return 'geo_denied'
    case 'OS-PLUG-GLOC-0010':
      return 'geo_timeout'
    default:
      return 'geo_unavailable'
  }
}

function browserSource(geo: Geolocation): GeoSource {
  return {
    watch(onFix, onError) {
      const id = geo.watchPosition(
        (pos) => onFix(toGeoFix(pos)),
        (err) => onError(BROWSER_ERRORS[err.code] ?? 'geo_unavailable'),
        { enableHighAccuracy: false, maximumAge: LOCATION.maximumAgeMs, timeout: LOCATION.timeoutMs },
      )
      return () => geo.clearWatch(id)
    },
  }
}

/** The plugin asks for permission itself when the watch starts (the app's own prompt, with its purpose string). */
const nativeSource: GeoSource = {
  watch(onFix, onError) {
    let stopped = false
    const watchId = nativePlugins()
      .then(({ Geolocation }) =>
        Geolocation.watchPosition(
          { enableHighAccuracy: LOCATION.nativeHighAccuracy, maximumAge: LOCATION.maximumAgeMs, timeout: LOCATION.timeoutMs, interval: LOCATION.nativeIntervalMs },
          (pos, err) => {
            if (stopped) return
            if (pos) onFix(toGeoFix(pos))
            else onError(nativeGeoError(err))
          },
        ),
      )
      .catch((err: unknown) => {
        if (!stopped) onError(nativeGeoError(err))
        return null
      })
    return () => {
      stopped = true
      void watchId.then(async (id) => {
        if (id === null) return
        const { Geolocation } = await nativePlugins()
        await Geolocation.clearWatch({ id })
      }).catch(() => {})
    }
  },
}

/** This device's source of positions, or null without one. */
export function geoSource(): GeoSource | null {
  if (isNativeApp()) return nativeSource
  const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
  return geo ? browserSource(geo) : null
}

/** Whether location is already allowed, without asking (false when unknown). */
export async function locationAllowed(): Promise<boolean> {
  try {
    if (isNativeApp()) {
      const { Geolocation } = await nativePlugins()
      return (await Geolocation.checkPermissions()).location === 'granted'
    }
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return false
    return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'
  } catch {
    return false // location services off (the plugin throws), or no Permissions API
  }
}
