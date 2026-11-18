// Validation for anything that comes back from storage or the URL. Invalid pieces fall back to
// defaults individually, so one corrupt value never takes the whole app down.
import { RIDE } from '../config'
import { LANGS } from '../i18n/lang'
import { isValidLngLat } from '../lib/geo'
import type { Place, PlaceKind } from '../types'
import type { PassChoice, SavedPlace, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  units: 'imperial',
  partySize: 1,
  maxRideMinutes: RIDE.defaultMaxRideMinutes,
  mapStyle: 'auto',
  language: 'auto',
  setupConfirmed: false,
  installTipSeen: false,
  passBySystem: {},
}

const PLACE_KINDS: ReadonlySet<PlaceKind> = new Set(['myLocation', 'search', 'mapPick', 'station', 'saved'])
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const clampInt = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt)

export function validatePlace(v: unknown): Place | null {
  if (!isObj(v) || !isValidLngLat(v.coord)) return null
  const kind = PLACE_KINDS.has(v.kind as PlaceKind) ? (v.kind as PlaceKind) : null
  const name = str(v.name, 120)
  if (!kind || !name) return null
  const place: Place = { kind, name, coord: [v.coord[0], v.coord[1]] }
  const detail = str(v.detail, 160)
  if (detail) place.detail = detail
  if (typeof v.stationId === 'string' && ID_RE.test(v.stationId)) place.stationId = v.stationId
  return place
}

function validatePassChoice(v: unknown): PassChoice | null {
  if (!isObj(v)) return null
  const planId = typeof v.planId === 'string' && ID_RE.test(v.planId) ? v.planId : null
  const includedMinutes = v.includedMinutes === null ? null : clampInt(v.includedMinutes, 1, 600, -1)
  if (includedMinutes === -1) return null
  return { planId, includedMinutes }
}

export function validateSettings(v: unknown): Settings {
  if (!isObj(v)) return { ...DEFAULT_SETTINGS }
  const passBySystem: Record<string, PassChoice> = {}
  if (isObj(v.passBySystem)) {
    for (const [k, choice] of Object.entries(v.passBySystem).slice(0, 50)) {
      const c = validatePassChoice(choice)
      if (c && ID_RE.test(k)) passBySystem[k] = c
    }
  }
  return {
    units: oneOf(v.units, ['imperial', 'metric'] as const, DEFAULT_SETTINGS.units),
    partySize: clampInt(v.partySize, 1, 4, DEFAULT_SETTINGS.partySize),
    maxRideMinutes: v.maxRideMinutes === 0 ? 0 : clampInt(v.maxRideMinutes, 5, 120, DEFAULT_SETTINGS.maxRideMinutes),
    mapStyle: oneOf(v.mapStyle, ['auto', 'light', 'dark'] as const, DEFAULT_SETTINGS.mapStyle),
    language: oneOf(v.language, ['auto', ...LANGS], DEFAULT_SETTINGS.language),
    setupConfirmed: typeof v.setupConfirmed === 'boolean' ? v.setupConfirmed : DEFAULT_SETTINGS.setupConfirmed,
    installTipSeen: typeof v.installTipSeen === 'boolean' ? v.installTipSeen : DEFAULT_SETTINGS.installTipSeen,
    passBySystem,
  }
}

export function validateSavedPlaces(v: unknown): SavedPlace[] {
  if (!Array.isArray(v)) return []
  const out: SavedPlace[] = []
  for (const item of v.slice(0, 20)) {
    if (!isObj(item)) continue
    const place = validatePlace(item.place)
    const id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : null
    const systemId = typeof item.systemId === 'string' && ID_RE.test(item.systemId) ? item.systemId : null
    const label = str(item.label, 40)
    if (!place || !id || !systemId || !label) continue
    out.push({ id, systemId, label, place, icon: oneOf(item.icon, ['home', 'work', 'star'] as const, 'star') })
  }
  return out
}

export function validateStringIds(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, max)
}

export function validatePlaces(v: unknown, max: number): Place[] {
  if (!Array.isArray(v)) return []
  return v.map(validatePlace).filter((p): p is Place => p !== null).slice(0, max)
}
