// Browse-mode panels: home (search, quick actions, saved/starred), dropped pin, station list,
// settings and about.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { POLL, RIDE } from '../../config'
import { useMeta, useNow, useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { getSystem, SYSTEMS } from '../../data/systems'
import { useReverseGeocode } from '../../geocode/hooks'
import { formatDistance, formatTimeAgo } from '../../lib/format'
import { haversine } from '../../lib/geo'
import { classifyStation } from '../../lib/stationState'
import { useAppStore } from '../../store/appStore'
import { LANG_NAMES, LANGS, type LanguageSetting } from '../../i18n/lang'
import { useI18n } from '../../i18n/useT'
import { useLocationStore } from '../../location/locationStore'
import type { Freshness } from '../../data/snapshot'
import type { Place } from '../../types'
import { AvailabilityPill } from '../primitives/Availability'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { changeCity, planRide, rideTo, startRideFrom } from '../ride/rideActions'
import { SearchBox } from './SearchBox'

export function FreshnessBadge({ freshness, lastUpdatedMs }: { freshness: Freshness; lastUpdatedMs: number | undefined }) {
  const now = useNow(10_000)
  const { t, lang } = useI18n()
  if (freshness === 'loading') return <span className="text-xs text-slate-500">{t.loadingLive}</span>
  if (freshness === 'error') return <span className="text-xs font-medium text-red-700">{t.liveUnavailable}</span>
  const age = lastUpdatedMs ? formatTimeAgo((now - lastUpdatedMs) / 1000, lang) : ''
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${freshness === 'stale' ? 'font-medium text-amber-700' : 'text-slate-500'}`}>
      <span className={`h-2 w-2 rounded-full ${freshness === 'stale' ? 'bg-amber-500' : 'bg-green-600'}`} aria-hidden />
      {freshness === 'stale' ? t.stale(age) : t.live(age)}
    </span>
  )
}

/** Fetches the latest station counts now instead of waiting for the next automatic refresh (~1 min). */
function RefreshButton() {
  const systemId = useAppStore((s) => s.systemId)
  const { refetch, isFetching } = useStationsSnapshot(systemId)
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={refetch}
      disabled={isFetching}
      aria-label={isFetching ? t.refreshingDataAria : t.refreshDataAria}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 disabled:opacity-60 dark:text-brand-300"
    >
      <Icon name="refresh" size={16} className={isFetching ? 'motion-safe:animate-spin' : ''} />
      {isFetching ? t.refreshing : t.refresh}
    </button>
  )
}

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  const { t } = useI18n()
  return (
    <header className="flex items-center gap-2 px-4 pt-4">
      {onBack && <IconButton icon="back" label={t.back} variant="ghost" onClick={onBack} />}
      <h2 className="text-xl font-semibold">{title}</h2>
    </header>
  )
}

const back = () => useAppStore.getState().setPanel('browse')

export function BrowsePanel() {
  const { systemId, saved, starred } = useAppStore(useShallow((s) => ({ systemId: s.systemId, saved: s.savedPlaces, starred: s.starredStations })))
  const { snapshot, freshness } = useStationsSnapshot(systemId)
  const system = getSystem(systemId)
  const partySize = useAppStore((s) => s.settings.partySize)
  const { t } = useI18n()
  const starredStations = (snapshot && systemId ? starred.filter((k) => k.startsWith(`${systemId}:`)).map((k) => snapshot.byId.get(k.slice(systemId.length + 1))) : []).filter((s) => !!s)
  const installed = snapshot?.stations.filter((s) => s.status?.isInstalled).length ?? 0
  const select = (p: Place) => {
    if (p.stationId) useAppStore.getState().selectStation(p.stationId)
    else rideTo(p)
  }
  if (system && snapshot && installed === 0) {
    return (
      <div className="space-y-3 p-4">
        <p className="font-medium">{t.noStationsInService(system.name)}</p>
      </div>
    )
  }
  return (
    <div className="space-y-3 p-4">
      <SearchBox label={t.searchStationsOrPlaces} onSelect={select} />
      {installed >= 2 && (
        <Button block size="nav" icon="bike" onClick={planRide}>
          {t.planARide}
        </Button>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <FreshnessBadge freshness={freshness} lastUpdatedMs={snapshot?.lastUpdatedMs} />
          <RefreshButton />
        </span>
        <button type="button" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => useAppStore.getState().setPanel('list')}>
          <Icon name="list" size={18} /> {t.stationList}
        </button>
      </div>
      {saved.filter((s) => s.systemId === systemId).length > 0 && (
        <ul className="space-y-1" aria-label={t.savedPlaces}>
          {saved
            .filter((s) => s.systemId === systemId)
            .map((s) => (
              <li key={s.id}>
                <button type="button" className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => rideTo(s.place)}>
                  <Icon name={s.icon} size={20} className="text-slate-500" />
                  <span className="font-medium">{s.icon === 'home' ? t.home : s.icon === 'work' ? t.work : s.label}</span>
                  <span className="truncate text-sm text-slate-500">{s.place.name}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      {starredStations.length > 0 && (
        <ul className="space-y-1" aria-label={t.starredStations}>
          {starredStations.map((st) => {
            const a = classifyStation(st, partySize)
            return (
              <li key={st.id}>
                <button type="button" className="flex min-h-12 w-full items-center gap-2 rounded-xl px-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => useAppStore.getState().selectStation(st.id)}>
                  <Icon name="star" size={18} className="text-amber-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{st.name}</span>
                  <AvailabilityPill kind="bikes" count={st.status?.bikes ?? 0} state={a.bikeState} size="sm" />
                  <AvailabilityPill kind="docks" count={st.status?.docks ?? 0} state={a.dockState} size="sm" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function PinCard() {
  const pin = useAppStore((s) => s.pin)
  const systemId = useAppStore((s) => s.systemId)
  const { place, loading } = useReverseGeocode(pin)
  const { t } = useI18n()
  if (!pin) return null
  const p: Place = place ?? { kind: 'mapPick', name: t.droppedPin, coord: pin }
  const asPlace: Place = { ...p, coord: pin }
  return (
    <section aria-label={t.droppedPin} className="space-y-3 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{loading ? t.lookingUp : p.name}</h2>
          {p.detail && <p className="text-sm text-slate-500">{p.detail}</p>}
        </div>
        <IconButton icon="close" label={t.close} onClick={() => {
            useAppStore.getState().dropPin(null)
            back()
          }} />
      </header>
      <div className="grid grid-cols-2 gap-2">
        <Button icon="bike" onClick={() => rideTo(asPlace)}>
          {t.rideHere}
        </Button>
        <Button variant="secondary" onClick={() => startRideFrom(asPlace)}>
          {t.startFromHere}
        </Button>
        {systemId && (
          <Button variant="ghost" icon="home" onClick={() => useAppStore.getState().savePlace({ systemId, icon: 'home', label: t.home, place: { ...asPlace, kind: 'saved' } })}>
            {t.saveAsHome}
          </Button>
        )}
        {systemId && (
          <Button variant="ghost" icon="work" onClick={() => useAppStore.getState().savePlace({ systemId, icon: 'work', label: t.work, place: { ...asPlace, kind: 'saved' } })}>
            {t.saveAsWork}
          </Button>
        )}
      </div>
    </section>
  )
}

/** Accessible station list (also the fallback when the map can't render). */
export function StationList() {
  const { systemId, mapMode, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, mapMode: s.mapMode, partySize: s.settings.partySize })))
  const units = useAppStore((s) => s.settings.units)
  const fix = useLocationStore((s) => s.fix)
  const { snapshot, freshness } = useStationsSnapshot(systemId)
  const { t, lang } = useI18n()
  const sorted = useMemo(() => {
    if (!snapshot) return []
    const list = [...snapshot.stations]
    if (fix) list.sort((a, b) => haversine(fix.coord, a.coord) - haversine(fix.coord, b.coord))
    else list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }, [snapshot, fix])
  return (
    <section aria-label={t.stations}>
      <Header title={t.stations} onBack={back} />
      <div className="px-4 py-2">
        <FreshnessBadge freshness={freshness} lastUpdatedMs={snapshot?.lastUpdatedMs} />
      </div>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {sorted.map((st) => {
          const a = classifyStation(st, partySize)
          return (
            <li key={st.id}>
              <button type="button" className="flex min-h-14 w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => useAppStore.getState().selectStation(st.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{st.name}</span>
                  {fix && <span className="text-sm text-slate-500">{formatDistance(haversine(fix.coord, st.coord), units, lang)}</span>}
                </span>
                {mapMode === 'bikes' ? (
                  <>
                    <AvailabilityPill kind="bikes" count={st.status?.bikes ?? 0} state={a.bikeState} size="sm" />
                    <AvailabilityPill kind="docks" count={st.status?.docks ?? 0} state={a.dockState} size="sm" />
                  </>
                ) : (
                  <>
                    <AvailabilityPill kind="docks" count={st.status?.docks ?? 0} state={a.dockState} size="sm" />
                    <AvailabilityPill kind="bikes" count={st.status?.bikes ?? 0} state={a.bikeState} size="sm" />
                  </>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function SettingsPanel() {
  const { settings, systemId } = useAppStore(useShallow((s) => ({ settings: s.settings, systemId: s.systemId })))
  const { details } = useSystemDetails(systemId)
  const update = useAppStore.getState().updateSettings
  const pass = systemId ? settings.passBySystem[systemId] : undefined
  const { t } = useI18n()
  // Labels may wrap and selects are capped, so no row is ever wider than the screen (Safari sizes a
  // native select to its longest option).
  const row = 'flex min-h-14 min-w-0 items-center justify-between gap-4 px-4 py-2 [&>span]:min-w-0'
  const select = 'min-h-11 min-w-0 max-w-[55%] shrink truncate rounded-lg bg-slate-100 px-2 dark:bg-slate-800'
  return (
    <section aria-label={t.settings}>
      <Header title={t.settings} onBack={back} />
      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        <label className={row}>
          <span>{t.language}</span>
          <select className={select} value={settings.language} onChange={(e) => update({ language: e.target.value as LanguageSetting })}>
            <option value="auto">{t.languageAuto}</option>
            {LANGS.map((l) => (
              <option key={l} value={l} lang={l}>
                {LANG_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label className={row}>
          <span>{t.city}</span>
          <select className={select} value={systemId ?? ''} onChange={(e) => changeCity(e.target.value)}>
            {[...SYSTEMS]
              .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.city || s.name}
                  {s.active ? '' : t.closedForSeason}
                </option>
              ))}
          </select>
        </label>
        <label className={row}>
          <span>{t.units}</span>
          <select className={select} value={settings.units} onChange={(e) => update({ units: e.target.value === 'metric' ? 'metric' : 'imperial' })}>
            <option value="imperial">{t.unitsImperial}</option>
            <option value="metric">{t.unitsMetric}</option>
          </select>
        </label>
        <label className={row}>
          <span>{t.maxRideBetweenDocks}</span>
          <select className={select} value={settings.maxRideMinutes} onChange={(e) => update({ maxRideMinutes: Number(e.target.value) })}>
            {[...new Set([...RIDE.maxRideChoices, settings.maxRideMinutes])]
              .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
              .map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t.unlimited : t.minutes(m)}
                </option>
              ))}
          </select>
        </label>
        <label className={row}>
          <span>{t.riders}</span>
          <select className={select} value={settings.partySize} onChange={(e) => update({ partySize: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {systemId && details && details.passes.length > 0 && (
          <label className={row}>
            <span>{t.myPass}</span>
            <select
              className={select}
              value={pass?.planId ?? ''}
              onChange={(e) => {
                const plan = details.passes.find((p) => p.id === e.target.value)
                useAppStore.getState().setPassChoice(systemId, plan ? { planId: plan.id, includedMinutes: plan.includedMinutes } : { planId: null, includedMinutes: details.defaultIncludedMinutes })
              }}
            >
              <option value="">{t.notSure(details.defaultIncludedMinutes)}</option>
              {details.passes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.includedMinutes ? t.perRide(p.includedMinutes) : t.perMinute}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={row}>
          <span>{t.setupConfirmed}</span>
          <input type="checkbox" className="h-6 w-6" checked={settings.setupConfirmed} onChange={(e) => update({ setupConfirmed: e.target.checked })} />
        </label>
        <label className={row}>
          <span>{t.mapStyle}</span>
          <select className={select} value={settings.mapStyle} onChange={(e) => update({ mapStyle: e.target.value === 'dark' ? 'dark' : e.target.value === 'light' ? 'light' : 'auto' })}>
            <option value="auto">{t.styleAuto}</option>
            <option value="light">{t.styleLight}</option>
            <option value="dark">{t.styleDark}</option>
          </select>
        </label>
        <p className="px-4 py-3 text-sm text-slate-500">
          {t.storageNote}
        </p>
        <button type="button" className={`${row} w-full text-left`} onClick={() => useAppStore.getState().setPanel('about')}>
          <span>{t.aboutLink}</span>
          <Icon name="chevronRight" size={20} />
        </button>
      </div>
    </section>
  )
}

export function AboutPanel() {
  const meta = useMeta()
  const systemId = useAppStore((s) => s.systemId)
  const { details } = useSystemDetails(systemId)
  const { t } = useI18n()
  return (
    <section aria-label={t.about} className="text-sm">
      <Header title={t.about} onBack={() => useAppStore.getState().setPanel('settings')} />
      <div className="space-y-3 p-4">
        <p>{t.aboutIntro}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t.creditStations(Math.round(POLL.statusAfterFeedMs / 60_000))}</li>
          <li>{t.creditMap}</li>
          <li>{t.creditRouting}</li>
          <li>{t.creditSearch}</li>
        </ul>
        <p>
          <a className="font-medium text-brand-700 underline dark:text-brand-300" href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">
            {t.reportMapProblem}
          </a>
        </p>
        {meta?.contactEmail && (
          <p>
            {t.operatorContact}{' '}
            <a className="underline" href={`mailto:${meta.contactEmail}`}>
              {meta.contactEmail}
            </a>
          </p>
        )}
        {details?.phone && <p>{t.support(details.name, details.phone)}</p>}
        {meta && <p className="text-slate-500">{t.version(meta.version)}</p>}
      </div>
    </section>
  )
}
