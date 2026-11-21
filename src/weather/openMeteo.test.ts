import { describe, expect, it } from 'vitest'
import forecast from '../test/fixtures/openmeteo/forecast_madison.json'
import { compassIndex, normalizeWeather, weatherKind, weatherUrl } from './openMeteo'

describe('Open-Meteo weather', () => {
  it('normalizes the captured Madison response (metric units, epoch ms)', () => {
    const w = normalizeWeather(forecast)
    expect(w).toMatchObject({ tempC: 14.4, feelsLikeC: 9.6, code: 0, windKph: 25.9, gustKph: 41.8, windFromDeg: 183, precipMm: 0, isDay: false })
    expect(w.sunriseMs).toBe(1795179390_000)
    expect(w.sunsetMs).toBe(1795213778_000)
    expect(w.observedMs).toBe(1795230900_000)
  })

  it('refuses a response without current values, and tolerates missing extras', () => {
    expect(() => normalizeWeather({ error: true, reason: 'Latitude must be in range' })).toThrow('Weather data is incomplete')
    const w = normalizeWeather({ current: { time: 1, temperature_2m: 3, wind_speed_10m: 4 } })
    expect(w).toMatchObject({ feelsLikeC: 3, gustKph: null, sunriseMs: null, sunsetMs: null })
  })

  it('asks for the city in its own time zone (so "today" is the city\'s day)', () => {
    const u = new URL(weatherUrl([-89.39761, 43.07097], 'America/Chicago'))
    expect(u.host).toBe('api.open-meteo.com')
    expect(u.searchParams.get('timezone')).toBe('America/Chicago')
    expect(u.searchParams.get('latitude')).toBe('43.0710')
    expect(u.searchParams.get('timeformat')).toBe('unixtime')
  })

  it('words WMO codes and wind directions', () => {
    expect([0, 2, 3, 45, 53, 63, 81, 73, 95].map(weatherKind)).toEqual(['clear', 'partlyCloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'showers', 'snow', 'thunder'])
    expect([0, 183, 270, 315, 359, -45, 22].map(compassIndex)).toEqual([0, 8, 12, 14, 0, 14, 1])
  })
})
