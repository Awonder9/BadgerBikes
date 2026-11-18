// Access to the single MapView's imperative API from anywhere in the UI (fit a plan, fly to a station,
// set padding from the bottom sheet). The AppShell owns the ref and provides it.
import { createContext, useCallback, useContext, type RefObject } from 'react'
import type { MapApi } from './types'

export const MapApiContext = createContext<RefObject<MapApi | null> | null>(null)

/**
 * Returns a stable getter for the MapApi. Call it inside event handlers or effects (never during
 * render); it returns null before the map is ready or when no map is mounted (tests).
 */
export function useMapApiGetter(): () => MapApi | null {
  const ref = useContext(MapApiContext)
  return useCallback(() => ref?.current ?? null, [ref])
}
