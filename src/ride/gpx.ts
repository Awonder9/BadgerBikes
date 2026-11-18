// Exact-route export (GPX 1.1) for navigation apps that follow a track turn by turn (Komoot, OsmAnd).
// Unlike a Google Maps link there is no stop limit and the app follows our line, not its own guess.
// Pure: no DOM. Every string is XML-escaped (station names contain `&`).
import { APP } from '../config'
import { buildPolylineIndex, haversine, pointAlong } from '../lib/geo'
import type { LngLat } from '../types'

export interface GpxStop {
  name: string
  coord: LngLat
  /** Meters along the route (where the line passes the dock). */
  along: number
}

export interface GpxInput {
  name: string
  /** The chosen route, start dock → destination. */
  route: readonly LngLat[]
  start: { name: string; coord: LngLat }
  /** Chosen docks in ride order; the last one ends the ride. */
  stops: readonly GpxStop[]
  destination: { name: string; coord: LngLat } | null
  /** ISO timestamp for <metadata><time>. */
  timeIso: string
}

/** A dock farther than this from the line gets its own track point, so the track reaches it. */
const OFF_LINE_METERS = 25

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

const ll = (c: LngLat) => `lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"`

/** Route coordinates from the start up to `toAlong` meters (the ride ends at the last dock, not the destination). */
export function sliceRoute(route: readonly LngLat[], toAlong: number): LngLat[] {
  if (route.length < 2) return [...route]
  const index = buildPolylineIndex([...route])
  if (toAlong >= index.total) return [...route]
  const { point, segmentIndex } = pointAlong(index, toAlong)
  const head = route.slice(0, segmentIndex + 1)
  // Ending exactly on a vertex: don't repeat it.
  return haversine(head.at(-1)!, point) < 0.5 ? head : [...head, point]
}

/** The ride as one GPX track (start dock → end dock) plus waypoints for the start, each dock and the destination. */
export function rideGpx(input: GpxInput): string {
  const end = input.stops.at(-1)
  const track = end ? sliceRoute(input.route, end.along) : [...input.route]
  // An off-route end dock (e.g. the one closest to the destination): finish the track at the dock itself.
  if (end && haversine(track.at(-1)!, end.coord) > OFF_LINE_METERS) track.push(end.coord)
  const wpts = [
    { name: `Start: ${input.start.name}`, coord: input.start.coord, sym: 'Bike Trail' },
    ...input.stops.map((s, i) => ({ name: i === input.stops.length - 1 ? `Dock here: ${s.name}` : `Dock: ${s.name}`, coord: s.coord, sym: 'Flag, Blue' })),
    ...(input.destination ? [{ name: `Destination: ${input.destination.name}`, coord: input.destination.coord, sym: 'Flag, Red' }] : []),
  ]
  const name = xmlEscape(input.name)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlEscape(APP.name)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata><name>${name}</name><time>${xmlEscape(input.timeIso)}</time></metadata>`,
    ...wpts.map((w) => `  <wpt ${ll(w.coord)}><name>${xmlEscape(w.name)}</name><sym>${w.sym}</sym></wpt>`),
    `  <trk><name>${name}</name><type>cycling</type><trkseg>`,
    ...track.map((c) => `    <trkpt ${ll(c)}/>`),
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n')
}

/** A file name safe on every platform, e.g. "bike-ride-to-cafe-coda.gpx". */
export function gpxFileName(destinationName: string | null): string {
  const slug = (destinationName ?? 'ride')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `bike-ride-to-${slug || 'destination'}.gpx`
}
