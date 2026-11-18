// Instant local station-name search (riders know stations by name; Photon doesn't index them).
import type { Station } from '../types'

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(st|street)\b/g, 'st')
    .replace(/\b(ave|avenue)\b/g, 'ave')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface StationMatch {
  station: Station
  score: number
}

/**
 * Ranks stations whose name/address contains every query token as a word prefix. Earlier and whole-word
 * matches rank higher; ties break by name. Returns at most `limit` matches.
 */
export function searchStations(stations: readonly Station[], query: string, limit = 5): StationMatch[] {
  const tokens = normalize(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return []
  const out: StationMatch[] = []
  for (const station of stations) {
    const words = normalize(`${station.name} ${station.address ?? ''}`).split(' ')
    let score = 0
    let ok = true
    for (const t of tokens) {
      let best = -1
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!
        if (w === t) best = Math.max(best, 3 - Math.min(2, i * 0.1))
        else if (w.startsWith(t)) best = Math.max(best, 2 - Math.min(1.5, i * 0.1))
      }
      if (best < 0) {
        ok = false
        break
      }
      score += best
    }
    if (ok) out.push({ station, score })
  }
  out.sort((a, b) => b.score - a.score || a.station.name.localeCompare(b.station.name))
  return out.slice(0, limit)
}
