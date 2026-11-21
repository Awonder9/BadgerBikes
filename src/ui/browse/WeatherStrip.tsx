// The city's weather now: temperature and conditions, wind (riders feel it most), and today's sunrise/sunset
// (riding home after dark). Data: GET /api/weather (Open-Meteo, the city's center); hidden until it loads.
import { useShallow } from 'zustand/react/shallow'
import { WEATHER } from '../../config'
import { useWeather } from '../../data/weather'
import { getSystem } from '../../data/systems'
import { useI18n } from '../../i18n/useT'
import { formatClockTime, formatSpeed, formatTemperature } from '../../lib/format'
import { useAppStore } from '../../store/appStore'
import { compassIndex, weatherKind } from '../../weather/openMeteo'
import { Icon } from '../primitives/Icon'

export function WeatherStrip() {
  const { systemId, units } = useAppStore(useShallow((s) => ({ systemId: s.systemId, units: s.settings.units })))
  const w = useWeather(systemId)
  const { t, lang } = useI18n()
  if (!w) return null
  const kind = weatherKind(w.code)
  const timeZone = getSystem(systemId)?.timezone
  const gust = w.gustKph !== null && w.gustKph - w.windKph >= WEATHER.gustShowDeltaKph ? formatSpeed(w.gustKph, units) : null
  return (
    <section aria-label={t.weatherNow} className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-900">
      <p className="flex items-center gap-2">
        <Icon name={kind === 'clear' ? (w.isDay ? 'sun' : 'moon') : 'cloud'} size={18} className="shrink-0 text-slate-500" />
        <span className="font-semibold">{formatTemperature(w.tempC, units)}</span>
        <span>{t.weatherKind[kind]}</span>
        <span className="text-slate-500">· {t.feelsLike(formatTemperature(w.feelsLikeC, units))}</span>
      </p>
      <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
        <Icon name="wind" size={18} className="shrink-0 text-slate-500" />
        {t.windLine(formatSpeed(w.windKph, units), t.compass[compassIndex(w.windFromDeg)] ?? '', gust)}
      </p>
      {w.sunriseMs !== null && w.sunsetMs !== null && (
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <Icon name="sun" size={18} className="shrink-0 text-slate-500" />
          {t.sunriseSunset(formatClockTime(w.sunriseMs, timeZone, lang), formatClockTime(w.sunsetMs, timeZone, lang))}
        </p>
      )}
      <a className="inline-block text-xs text-slate-500 underline" href={WEATHER.creditUrl} target="_blank" rel="noopener noreferrer">
        {t.weatherCredit}
      </a>
    </section>
  )
}
