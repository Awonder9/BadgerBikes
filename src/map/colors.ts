// Colors shared by map layer expressions and the UI. Keep in sync with the @theme tokens in
// src/index.css (--color-avail-*, --color-route-*). Availability is never encoded by hue alone:
// 'none' renders as a hollow ring with "0", 'unavailable' as grey with ✕ and no number.
import type { PathKind } from '../routing/details'
import type { AvailabilityState } from '../types'

export const AVAILABILITY_COLORS: Readonly<Record<AvailabilityState, string>> = {
  ok: '#15803d',
  low: '#b45309',
  none: '#b91c1c',
  unavailable: '#6b7280',
}

export const ROUTE_COLORS = {
  light: { walk: '#475569', bike: '#0f766e', bikeCasing: '#ffffff' },
  dark: { walk: '#cbd5e1', bike: '#2dd4bf', bikeCasing: '#0f172a' },
} as const

/**
 * Route line colors by kind of way (map line, breakdown bar and legend all use these). Greens = away from
 * cars, blues/teal = bike lanes, amber = shared with cars, grey = quiet street, red = road with traffic.
 */
export const PATH_COLORS: Readonly<Record<PathKind, string>> = {
  bikePath: '#047857',
  sharedPath: '#22c55e',
  protectedLane: '#0d9488',
  bikeLane: '#2563eb',
  sharedLane: '#f59e0b',
  quietStreet: '#64748b',
  busyRoad: '#dc2626',
}

export const BRAND = '#0f766e'
export const USER_PUCK = { fill: '#2563eb', stroke: '#ffffff', accuracy: 'rgba(37, 99, 235, 0.15)', degraded: '#94a3b8' } as const

/** Gold ring around starred docks, and the favorite-place marker. */
export const STAR_GOLD = '#f59e0b'
/** Saved-place markers on the map (white icon on this fill). */
export const SAVED_MARKER = { home: '#4f46e5', work: '#4f46e5', star: STAR_GOLD, outline: '#ffffff' } as const
