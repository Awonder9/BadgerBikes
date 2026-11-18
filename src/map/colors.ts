// Colors shared by map layer expressions and the UI. Keep in sync with the @theme tokens in
// src/index.css (--color-avail-*, --color-route-*). Availability is never encoded by hue alone:
// 'none' renders as a hollow ring with "0", 'unavailable' as grey with ✕ and no number.
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

export const BRAND = '#0f766e'
export const USER_PUCK = { fill: '#2563eb', stroke: '#ffffff', accuracy: 'rgba(37, 99, 235, 0.15)', degraded: '#94a3b8' } as const
