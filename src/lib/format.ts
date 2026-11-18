// Display formatting. Internal units are meters and seconds; convert only here.
export type Units = 'imperial' | 'metric'

const FEET_PER_METER = 3.280839895
const METERS_PER_MILE = 1609.344

/**
 * Human distance. Imperial: feet (rounded to 10 ft, 50 ft above 500 ft) below 0.1 mi, else miles.
 * Metric: meters (rounded to 5/10 m) below 1 km, else km.
 */
export function formatDistance(meters: number, units: Units): string {
  const m = Math.max(0, meters)
  if (units === 'imperial') {
    const feet = m * FEET_PER_METER
    if (m < 0.1 * METERS_PER_MILE) {
      const step = feet > 500 ? 50 : 10
      return `${Math.max(step, Math.round(feet / step) * step).toLocaleString('en-US')} ft`
    }
    const miles = m / METERS_PER_MILE
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toString()} mi`
  }
  if (m < 1000) {
    const step = m < 100 ? 5 : 10
    return `${Math.max(step, Math.round(m / step) * step)} m`
  }
  const km = m / 1000
  return `${km < 10 ? km.toFixed(1) : Math.round(km).toString()} km`
}

/** "45 s" (under a minute), "1 min", "12 min", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return s < 30 ? '<1 min' : '1 min'
  const totalMin = Math.round(s / 60)
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${h} h` : `${h} h ${min} min`
}

/** Local clock time ("3:45 PM") for an epoch-ms instant, optionally in a specific IANA zone. */
export function formatClockTime(epochMs: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(epochMs)
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(epochMs)
  }
}

/** "just now", "20 s ago", "3 min ago", "2 h ago". */
export function formatTimeAgo(secondsAgo: number): string {
  const s = Math.max(0, Math.round(secondsAgo))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return `${h} h ago`
}

/** "1 bike", "3 bikes", "0 docks". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** "3 e-bikes · 5 classic" (or just the one kind there is). */
export function bikeMix(ebikes: number, classic: number): string {
  const e = `${ebikes} e-bike${ebikes === 1 ? '' : 's'}`
  const c = `${classic} classic`
  if (ebikes === 0) return c
  if (classic === 0) return e
  return `${e} · ${c}`
}
