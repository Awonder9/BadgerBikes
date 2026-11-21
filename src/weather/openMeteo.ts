// Current weather, wind, and today's sunrise/sunset for a city (Open-Meteo: no key; free for non-commercial use;
// attribution "Weather data by Open-Meteo.com", CC BY 4.0). Called by the Worker for the city's center — never
// for the rider's location. Pure apart from the injected upstream; runtime-agnostic (the Worker imports it).
import { CACHE_TTL_MS, ENDPOINTS } from '../config'
import { AppError } from '../lib/errors'
import type { UpstreamFetch } from '../lib/upstream'
import type { LngLat } from '../types'

/** Metric units; the client converts for display. */
export interface Weather {
  /** °C */
  tempC: number
  /** °C ("feels like": wind chill / heat index). */
  feelsLikeC: number
  /** WMO weather interpretation code (0 clear … 95+ thunderstorm). */
  code: number
  /** km/h, 10 m above ground. */
  windKph: number
  /** km/h, or null when not reported. */
  gustKph: number | null
  /** Degrees the wind blows FROM (0 = north, 90 = east). */
  windFromDeg: number
  /** mm in the last 15 minutes. */
  precipMm: number
  isDay: boolean
  /** Today's sunrise / sunset in the city (epoch ms), or null (polar day/night). */
  sunriseMs: number | null
  sunsetMs: number | null
  /** When the current values are for (epoch ms). */
  observedMs: number
}

const CURRENT = ['temperature_2m', 'apparent_temperature', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'precipitation', 'is_day'] as const

/** The request for a point; `timeZone` (the city's IANA zone) makes "today" the city's day for sunrise/sunset. */
export function weatherUrl(at: LngLat, timeZone: string): string {
  const q = new URLSearchParams({
    latitude: at[1].toFixed(4),
    longitude: at[0].toFixed(4),
    current: CURRENT.join(','),
    daily: 'sunrise,sunset',
    forecast_days: '1',
    timezone: timeZone,
    timeformat: 'unixtime',
  })
  return `${ENDPOINTS.openMeteo}/v1/forecast?${q.toString()}`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Open-Meteo's response → Weather; throws 'bad_response' when the current values are missing. */
export function normalizeWeather(json: unknown): Weather {
  const cur = isObj(json) && isObj(json.current) ? json.current : null
  const daily = isObj(json) && isObj(json.daily) ? json.daily : null
  const tempC = num(cur?.temperature_2m)
  const windKph = num(cur?.wind_speed_10m)
  const time = num(cur?.time)
  if (tempC === null || windKph === null || time === null) throw new AppError('bad_response', 'Weather data is incomplete', { provider: 'openmeteo' })
  const first = (v: unknown) => (Array.isArray(v) ? num(v[0]) : null)
  const sunrise = first(daily?.sunrise)
  const sunset = first(daily?.sunset)
  return {
    tempC,
    feelsLikeC: num(cur?.apparent_temperature) ?? tempC,
    code: num(cur?.weather_code) ?? 0,
    windKph,
    gustKph: num(cur?.wind_gusts_10m),
    windFromDeg: num(cur?.wind_direction_10m) ?? 0,
    precipMm: num(cur?.precipitation) ?? 0,
    isDay: cur?.is_day === 1,
    sunriseMs: sunrise === null ? null : sunrise * 1000,
    sunsetMs: sunset === null ? null : sunset * 1000,
    observedMs: time * 1000,
  }
}

export async function fetchWeather(at: LngLat, timeZone: string, upstream: UpstreamFetch, opts: { signal?: AbortSignal } = {}): Promise<Weather> {
  const url = weatherUrl(at, timeZone)
  const json = await upstream<unknown>({ url, group: 'openmeteo', priority: 'background', provider: 'openmeteo', signal: opts.signal, cacheKey: `openmeteo|${url}`, cacheTtlMs: CACHE_TTL_MS.weather })
  return normalizeWeather(json)
}

/** What the WMO code says, in a few words (the client words it per language). */
export type WeatherKind = 'clear' | 'partlyCloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'showers' | 'thunder'

export function weatherKind(code: number): WeatherKind {
  if (code <= 1) return 'clear'
  if (code === 2) return 'partlyCloudy'
  if (code === 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return code >= 80 ? 'showers' : 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'thunder'
  return 'cloudy'
}

/** The 16-point compass point (0 = N, 4 = E, 8 = S, 12 = W) for a direction in degrees; the UI names it per language. */
export function compassIndex(deg: number): number {
  return Math.round((((deg % 360) + 360) % 360) / 22.5) % 16
}
