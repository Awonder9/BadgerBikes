// The GPX file a ride is sent to Strava as (POST /api/strava/upload builds it in the Worker). Strava requires a time on
// every track point; the app can't record GPS while Google Maps is in front, so the track is the route as planned
// and each point's time is spread along it in proportion to distance, from the ride's real start to its end. The
// activity's description says so (STRAVA note, added by the Worker). Pure: no DOM; every string XML-escaped.
import { APP } from '../config'
import { haversine } from '../lib/geo'
import { xmlEscape } from '../ride/gpx'
import type { LngLat } from '../types'

export interface StravaGpxInput {
  name: string
  line: readonly LngLat[]
  startedAtMs: number
  elapsedS: number
}

/** ISO 8601 UTC without milliseconds (what GPX readers expect). */
const iso = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')

export function stravaGpx({ name, line, startedAtMs, elapsedS }: StravaGpxInput): string {
  const cum = [0]
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + haversine(line[i - 1]!, line[i]!))
  const total = cum.at(-1) || 1
  const pts = line.map((c, i) => `    <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"><time>${iso(startedAtMs + (cum[i]! / total) * elapsedS * 1000)}</time></trkpt>`)
  const title = xmlEscape(name)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlEscape(APP.name)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata><name>${title}</name><time>${iso(startedAtMs)}</time></metadata>`,
    `  <trk><name>${title}</name><type>cycling</type><trkseg>`,
    ...pts,
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n')
}
