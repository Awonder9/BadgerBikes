// Encoded polyline algorithm (Google format). Valhalla uses precision 6, OSRM/Google precision 5.
// Decoded output is [lon, lat] to match the rest of the app.
import type { LngLat } from '../types'

export function decodePolyline(encoded: string, precision = 6): LngLat[] {
  const factor = 10 ** precision
  const coords: LngLat[] = []
  const deltas: number[] = []
  let result = 0
  let shift = 0
  // Each coordinate is two zig-zag varints (lat, lon). Collect complete values; a truncated
  // trailing value or an unpaired latitude is ignored.
  for (let i = 0; i < encoded.length; i++) {
    const byte = encoded.charCodeAt(i) - 63
    result |= (byte & 0x1f) << shift
    shift += 5
    if (byte < 0x20 || shift >= 35) {
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1)
      result = 0
      shift = 0
    }
  }
  let lat = 0
  let lon = 0
  for (let i = 0; i + 1 < deltas.length; i += 2) {
    lat += deltas[i]!
    lon += deltas[i + 1]!
    coords.push([lon / factor, lat / factor])
  }
  return coords
}

export function encodePolyline(coords: readonly LngLat[], precision = 6): string {
  const factor = 10 ** precision
  let out = ''
  let prevLat = 0
  let prevLon = 0
  const encodeValue = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
      v >>= 5
    }
    out += String.fromCharCode(v + 63)
  }
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * factor)
    const iLon = Math.round(lon * factor)
    encodeValue(iLat - prevLat)
    encodeValue(iLon - prevLon)
    prevLat = iLat
    prevLon = iLon
  }
  return out
}
