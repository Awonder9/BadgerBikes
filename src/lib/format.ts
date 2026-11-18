// Display formatting. Internal units are meters and seconds; convert only here.
// Every formatter takes the UI language last (default English).
import { LANG_TAGS, type Lang } from '../i18n/lang'

export type Units = 'imperial' | 'metric'

/** Unit words per language. Chinese "ago" is a suffix with no space ("3 分钟前"). */
const WORDS: Record<Lang, { ft: string; mi: string; m: string; km: string; s: string; min: string; h: string; ago: (x: string) => string; justNow: string }> = {
  en: { ft: 'ft', mi: 'mi', m: 'm', km: 'km', s: 's', min: 'min', h: 'h', ago: (x) => `${x} ago`, justNow: 'just now' },
  'zh-Hans': { ft: '英尺', mi: '英里', m: '米', km: '公里', s: '秒', min: '分钟', h: '小时', ago: (x) => `${x}前`, justNow: '刚刚' },
  'zh-Hant': { ft: '英尺', mi: '英里', m: '公尺', km: '公里', s: '秒', min: '分鐘', h: '小時', ago: (x) => `${x}前`, justNow: '剛剛' },
}

const FEET_PER_METER = 3.280839895
const METERS_PER_MILE = 1609.344

/**
 * Human distance. Imperial: feet (rounded to 10 ft, 50 ft above 500 ft) below 0.1 mi, else miles.
 * Metric: meters (rounded to 5/10 m) below 1 km, else km.
 */
export function formatDistance(meters: number, units: Units, lang: Lang = 'en'): string {
  const w = WORDS[lang]
  const m = Math.max(0, meters)
  if (units === 'imperial') {
    const feet = m * FEET_PER_METER
    if (m < 0.1 * METERS_PER_MILE) {
      const step = feet > 500 ? 50 : 10
      return `${Math.max(step, Math.round(feet / step) * step).toLocaleString('en-US')} ${w.ft}`
    }
    const miles = m / METERS_PER_MILE
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toString()} ${w.mi}`
  }
  if (m < 1000) {
    const step = m < 100 ? 5 : 10
    return `${Math.max(step, Math.round(m / step) * step)} ${w.m}`
  }
  const km = m / 1000
  return `${km < 10 ? km.toFixed(1) : Math.round(km).toString()} ${w.km}`
}

/** A bare unit word ("ft", "公尺") for numbers formatted elsewhere, e.g. elevation gain. */
export function unitWord(unit: 'ft' | 'm', lang: Lang = 'en'): string {
  return WORDS[lang][unit]
}

/** "45 s" (under a minute), "1 min", "12 min", "1 h 5 min". */
export function formatDuration(seconds: number, lang: Lang = 'en'): string {
  const w = WORDS[lang]
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return s < 30 ? `<1 ${w.min}` : `1 ${w.min}`
  const totalMin = Math.round(s / 60)
  if (totalMin < 60) return `${totalMin} ${w.min}`
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${h} ${w.h}` : `${h} ${w.h} ${min} ${w.min}`
}

/** Local clock time ("3:45 PM") for an epoch-ms instant, optionally in a specific IANA zone. */
export function formatClockTime(epochMs: number, timeZone?: string, lang: Lang = 'en'): string {
  try {
    return new Intl.DateTimeFormat(LANG_TAGS[lang], { hour: 'numeric', minute: '2-digit', timeZone }).format(epochMs)
  } catch {
    return new Intl.DateTimeFormat(LANG_TAGS[lang], { hour: 'numeric', minute: '2-digit' }).format(epochMs)
  }
}

/** "just now", "20 s ago", "3 min ago", "2 h ago". */
export function formatTimeAgo(secondsAgo: number, lang: Lang = 'en'): string {
  const w = WORDS[lang]
  const s = Math.max(0, Math.round(secondsAgo))
  if (s < 10) return w.justNow
  if (s < 60) return w.ago(`${s} ${w.s}`)
  const min = Math.floor(s / 60)
  if (min < 60) return w.ago(`${min} ${w.min}`)
  const h = Math.floor(min / 60)
  return w.ago(`${h} ${w.h}`)
}

/** "1 bike", "3 bikes", "0 docks". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** "3 e-bikes · 5 classic" (or just the one kind there is). */
export function bikeMix(ebikes: number, classic: number, lang: Lang = 'en'): string {
  const zh = lang !== 'en'
  const e = zh ? `${ebikes} ${lang === 'zh-Hans' ? '辆电动单车' : '輛電動單車'}` : `${ebikes} e-bike${ebikes === 1 ? '' : 's'}`
  const c = zh ? `${classic} ${lang === 'zh-Hans' ? '辆普通单车' : '輛普通單車'}` : `${classic} classic`
  if (ebikes === 0) return c
  if (classic === 0) return e
  return `${e} · ${c}`
}
