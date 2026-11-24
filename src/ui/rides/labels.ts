// Names of review periods in the rider's language, and the device's time zone (reviews follow the rider's calendar).
import type { Messages } from '../../i18n'
import { LANG_TAGS, type Lang } from '../../i18n/lang'
import type { Period } from '../../history/review'

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const utc = (day: string) => Date.parse(`${day}T12:00:00Z`)

/** "Nov 17 – 23", "November 2026", "2026". */
export function periodLabel(p: Period, lang: Lang, t: Messages): string {
  const tag = LANG_TAGS[lang]
  if (p.kind === 'year') return p.first.slice(0, 4)
  if (p.kind === 'month') return new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(p.first))
  const f = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return t.rides.weekRange(f.format(utc(p.first)), f.format(utc(p.last)))
}

/** The weekday's name (0 = Sunday). */
export const weekdayName = (d: number, lang: Lang): string => new Intl.DateTimeFormat(LANG_TAGS[lang], { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 10, 15 + d, 12))

/** The month's short name (0 = January), for the year chart. */
export const monthInitial = (m: number, lang: Lang): string => new Intl.DateTimeFormat(LANG_TAGS[lang], { month: 'narrow', timeZone: 'UTC' }).format(Date.UTC(2026, m, 15))
