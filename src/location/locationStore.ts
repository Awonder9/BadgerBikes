// The rider's position (browse accuracy). Location is only watched after the rider asks for it
// (Locate button, "nearest dock", place-search biasing). Never persisted.
import { useEffect } from 'react'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { LOCATION } from '../config'
import type { GeoFix, LngLat } from '../types'

export type GeoErrorCode = 'geo_denied' | 'geo_unavailable' | 'geo_timeout' | 'geo_unsupported'

export interface LocationState {
  fix: GeoFix | null
  geoError: GeoErrorCode | null
  /** The rider asked to use their location (starts the watch). */
  requested: boolean
  /** Bumped when the rider asks again after an error: restarts the watch (and asks for permission again). */
  attempt: number
  requestLocation(): void
  setFix(fix: GeoFix): void
  setGeoError(code: GeoErrorCode | null): void
}

export const useLocationStore = create<LocationState>()(
  subscribeWithSelector((set) => ({
    fix: null,
    geoError: null,
    requested: false,
    attempt: 0,
    // Asking while the watch is running changes nothing; asking after an error (denied, unavailable, timed
    // out) starts a new watch, so a rider who has since allowed location isn't stuck until a reload.
    requestLocation: () => set((s) => (s.requested && !s.geoError ? s : { requested: true, geoError: null, attempt: s.attempt + 1 })),
    setFix: (fix) => set({ fix, geoError: null }),
    setGeoError: (geoError) => set({ geoError }),
  })),
)

export function toGeoFix(pos: GeolocationPosition): GeoFix {
  const c = pos.coords
  const num = (v: number | null) => (v === null || Number.isNaN(v) || v < 0 ? null : v)
  return { coord: [c.longitude, c.latitude], accuracy: c.accuracy, heading: num(c.heading), speed: num(c.speed), timestampMs: pos.timestamp }
}

const ERR: Record<number, GeoErrorCode> = { 1: 'geo_denied', 2: 'geo_unavailable', 3: 'geo_timeout' }

/**
 * Mounted once (App): watches the position once requested (attempt > 0), restarting a watch that went quiet,
 * and starting over when the rider asks again after an error.
 */
export function useLocationWatcher(): void {
  const attempt = useLocationStore((s) => s.attempt)
  useEffect(() => {
    if (attempt === 0) return
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
    const store = useLocationStore.getState()
    if (!geo) {
      store.setGeoError('geo_unsupported')
      return
    }
    let watchId: number | null = null
    let lastFixAt = Date.now()
    const begin = () => {
      watchId = geo.watchPosition(
        (pos) => {
          lastFixAt = Date.now()
          useLocationStore.getState().setFix(toGeoFix(pos))
        },
        (err) => useLocationStore.getState().setGeoError(ERR[err.code] ?? 'geo_unavailable'),
        { enableHighAccuracy: false, maximumAge: LOCATION.maximumAgeMs, timeout: LOCATION.timeoutMs },
      )
    }
    begin()
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        watchdog = null
        if (Date.now() - lastFixAt > LOCATION.watchdogMs && watchId !== null) {
          geo.clearWatch(watchId)
          begin()
        }
      }, LOCATION.watchdogMs)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (watchdog) clearTimeout(watchdog)
      if (watchId !== null) geo.clearWatch(watchId)
    }
  }, [attempt])
}

/**
 * Resolves with a recent position, asking for location if needed: a fix newer than LOCATION.freshFixMs right
 * away, else the next fix. Gives up on denial or after `ms`, then falls back to the last known position (a
 * stationary phone may not report again), or null when there is none.
 */
export function waitForFix(ms: number = LOCATION.waitMs): Promise<LngLat | null> {
  const s = useLocationStore.getState()
  if (s.fix && Date.now() - s.fix.timestampMs < LOCATION.freshFixMs) return Promise.resolve(s.fix.coord)
  const known = s.fix
  return new Promise((resolve) => {
    const finish = (coord: LngLat | null) => {
      clearTimeout(timer)
      unsub()
      resolve(coord)
    }
    const timer = setTimeout(() => finish(useLocationStore.getState().fix?.coord ?? null), ms)
    // Subscribed before asking, so an answer that arrives right away is never missed.
    const unsub = useLocationStore.subscribe(
      (st) => [st.fix, st.geoError] as const,
      ([fix, err]) => {
        if (fix && fix !== known) finish(fix.coord)
        else if (err === 'geo_denied' || err === 'geo_unsupported') finish(null)
      },
      { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
    )
    useLocationStore.getState().requestLocation()
  })
}
