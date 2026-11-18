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
  requestLocation(): void
  setFix(fix: GeoFix): void
  setGeoError(code: GeoErrorCode | null): void
}

export const useLocationStore = create<LocationState>()(
  subscribeWithSelector((set) => ({
    fix: null,
    geoError: null,
    requested: false,
    requestLocation: () => set({ requested: true }),
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

/** Mounted once (App): watches the position while requested, restarting a watch that went quiet. */
export function useLocationWatcher(): void {
  const requested = useLocationStore((s) => s.requested)
  useEffect(() => {
    if (!requested) return
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
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setTimeout(() => {
        if (Date.now() - lastFixAt > LOCATION.watchdogMs && watchId !== null) {
          geo.clearWatch(watchId)
          begin()
        }
      }, LOCATION.watchdogMs)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (watchId !== null) geo.clearWatch(watchId)
    }
  }, [requested])
}

/** Resolves with a recent position (asking for location if needed), or null on denial/timeout. */
export function waitForFix(ms: number = LOCATION.waitMs): Promise<LngLat | null> {
  const s = useLocationStore.getState()
  if (s.fix && Date.now() - s.fix.timestampMs < LOCATION.freshFixMs) return Promise.resolve(s.fix.coord)
  s.requestLocation()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(null)
    }, ms)
    const unsub = useLocationStore.subscribe(
      (st) => [st.fix, st.geoError] as const,
      ([fix, err]) => {
        if (fix || err === 'geo_denied' || err === 'geo_unsupported') {
          clearTimeout(timer)
          unsub()
          resolve(fix?.coord ?? null)
        }
      },
    )
  })
}
