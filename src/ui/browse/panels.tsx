// Browse-mode panels: home (search, quick actions, saved/starred), dropped pin, station list,
// settings and about.
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { APP, POLL, RIDE } from '../../config'
import { useMeta, useNow, useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { getSystem, SYSTEMS } from '../../data/systems'
import { useReverseGeocode } from '../../geocode/hooks'
import { formatDistance, formatTimeAgo } from '../../lib/format'
import { haversine } from '../../lib/geo'
import { classifyStation, fleetComposition } from '../../lib/stationState'
import { findSavedPlace, useAppStore } from '../../store/appStore'
import type { SavedPlace, Settings } from '../../store/types'
import { LANG_NAMES, LANGS, type LanguageSetting } from '../../i18n/lang'
import { useI18n } from '../../i18n/useT'
import { useLocationStore } from '../../location/locationStore'
import { freshnessOf } from '../../data/snapshot'
import { directionsFromHereUrl } from '../../ride/googleMaps'
import { rideUnderWay, useRideStore } from '../../ride/rideStore'
import type { Place } from '../../types'
import { isNativeApp } from '../platform'
import { AvailabilityPill } from '../primitives/Availability'
import { Button, ButtonLink, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { changeCity, planRide, rideTo, startRideFrom } from '../ride/rideActions'
import { AlertsSettings } from '../ride/AlertsHelp'
import { PassSelect } from './PassSelect'
import { SearchBox } from './SearchBox'
import { useNearestStation } from './useNearestOpenDock'
import { WeatherStrip } from './WeatherStrip'

/** "Live · 20 s ago" / "Data may be stale" — ages on its own clock, so its parents don't re-render with it. */
export function FreshnessBadge({ hasData, isError, lastUpdatedMs }: { hasData: boolean; isError: boolean; lastUpdatedMs: number | undefined }) {
  const now = useNow(10_000)
  const { t, lang } = useI18n()
  const freshness = freshnessOf({ hasData, isError, lastUpdatedMs, nowMs: now })
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

/** Where's the closest bike, and where can I return one? The closest dock with bikes / room, from the rider's position. */
function NearestButtons() {
  const bike = useNearestStation('bike')
  const dock = useNearestStation('dock')
  const { t } = useI18n()
  const message = bike.message ?? dock.message
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button block variant="secondary" icon="bike" className="whitespace-nowrap" disabled={bike.finding} onClick={bike.find}>
          {bike.finding ? t.findingYou : t.nearestBike}
        </Button>
        <Button block variant="secondary" icon="dock" className="whitespace-nowrap" disabled={dock.finding} onClick={dock.find}>
          {dock.finding ? t.findingYou : t.nearestDockShort}
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
          {message}
        </p>
      )}
    </>
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
  const { snapshot, error } = useStationsSnapshot(systemId)
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
      <NearestButtons />
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <FreshnessBadge hasData={!!snapshot} isError={!!error} lastUpdatedMs={snapshot?.lastUpdatedMs} />
          <RefreshButton />
        </span>
        <button type="button" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => useAppStore.getState().setPanel('list')}>
          <Icon name="list" size={18} /> {t.stationList}
        </button>
      </div>
      <WeatherStrip />
      {saved.filter((s) => s.systemId === systemId).length > 0 && (
        <ul className="space-y-1" aria-label={t.savedPlaces}>
          {saved
            .filter((s) => s.systemId === systemId)
            .map((s) => (
              <li key={s.id}>
                <button type="button" className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => rideTo(s.place)}>
                  <Icon name={s.icon} size={20} className="text-slate-500" />
                  {s.icon === 'star' ? (
                    <span className="truncate font-medium">{s.place.name}</span>
                  ) : (
                    <>
                      <span className="font-medium">{s.icon === 'home' ? t.home : t.work}</span>
                      <span className="truncate text-sm text-slate-500">{s.place.name}</span>
                    </>
                  )}
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
      {saved.filter((s) => s.systemId === systemId).length === 0 && <p className="text-sm text-slate-500">{t.pinHint}</p>}
    </div>
  )
}

export function PinCard() {
  const pin = useAppStore((s) => s.pin)
  const systemId = useAppStore((s) => s.systemId)
  const saved = useAppStore((s) => s.savedPlaces)
  // Mid-ride (a long press, or a saved place's marker tapped on the map) the pin must not re-plan the ride.
  const riding = useRideStore(rideUnderWay)
  // A saved place (its marker tapped) already has its name: its spot — Home, Work — isn't sent out to look it up.
  const savedHere = pin ? findSavedPlace(saved, systemId, null, pin) : undefined
  const { place, loading } = useReverseGeocode(savedHere ? null : pin)
  const { t } = useI18n()
  if (!pin) return null
  const p: Place = savedHere?.place ?? place ?? { kind: 'mapPick', name: t.droppedPin, coord: pin }
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
        {riding ? (
          // Bike directions from where the rider is, keeping the ride's plan, timer and alerts (see StationCard).
          <ButtonLink icon="bike" href={directionsFromHereUrl(pin, 'bicycling')} aria-label={t.bikeDirectionsAria(p.name)}>
            {t.rideHere}
          </ButtonLink>
        ) : (
          <Button icon="bike" onClick={() => rideTo(asPlace)}>
            {t.rideHere}
          </Button>
        )}
        <Button variant="secondary" onClick={() => startRideFrom(asPlace)}>
          {t.startFromHere}
        </Button>
        {systemId &&
          (['home', 'work', 'star'] as const).map((icon) => {
            const existing = findSavedPlace(saved, systemId, icon, pin)
            const label = icon === 'home' ? (existing ? t.savedAsHome : t.saveAsHome) : icon === 'work' ? (existing ? t.savedAsWork : t.saveAsWork) : existing ? t.placeSaved : t.savePlace
            return (
              <Button
                key={icon}
                variant={existing ? 'primary' : 'ghost'}
                icon={existing ? 'check' : icon}
                aria-pressed={!!existing}
                disabled={loading}
                className={icon === 'star' ? 'col-span-2' : ''}
                onClick={() => {
                  const store = useAppStore.getState()
                  if (existing) store.removeSavedPlace(existing.id)
                  else store.savePlace({ systemId, icon, label: icon === 'home' ? t.home : icon === 'work' ? t.work : p.name, place: { ...asPlace, kind: 'saved' } })
                }}
              >
                {label}
              </Button>
            )
          })}
      </div>
    </section>
  )
}

/** Accessible station list (also the fallback when the map can't render). */
export function StationList() {
  const { systemId, mapMode, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, mapMode: s.mapMode, partySize: s.settings.partySize })))
  const units = useAppStore((s) => s.settings.units)
  const fix = useLocationStore((s) => s.fix)
  const { snapshot, error } = useStationsSnapshot(systemId)
  const { t, lang } = useI18n()
  // Each station's distance once per position (the list re-sorts and re-labels as the position updates).
  const sorted = useMemo(() => {
    if (!snapshot) return []
    const rows = snapshot.stations.map((st) => ({ st, meters: fix ? haversine(fix.coord, st.coord) : null }))
    rows.sort((a, b) => (a.meters !== null && b.meters !== null ? a.meters - b.meters : a.st.name.localeCompare(b.st.name)))
    return rows
  }, [snapshot, fix])
  return (
    <section aria-label={t.stations}>
      <Header title={t.stations} onBack={back} />
      <div className="px-4 py-2">
        <FreshnessBadge hasData={!!snapshot} isError={!!error} lastUpdatedMs={snapshot?.lastUpdatedMs} />
      </div>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {sorted.map(({ st, meters }) => {
          const a = classifyStation(st, partySize)
          return (
            <li key={st.id}>
              <button type="button" className="flex min-h-14 w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => useAppStore.getState().selectStation(st.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{st.name}</span>
                  {meters !== null && <span className="text-sm text-slate-500">{formatDistance(meters, units, lang)}</span>}
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
  const { snapshot } = useStationsSnapshot(systemId)
  // "Prefer e-bikes" only means something where there are both kinds.
  const mixedFleet = !!snapshot && fleetComposition(snapshot.stations) === 'mixed'
  const update = (patch: Partial<Settings>) => useAppStore.getState().updateSettings(patch)
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
        {mixedFleet && (
          <label className={row}>
            <span>
              {t.preferEbikes}
              <span className="block text-sm text-slate-500">{t.preferEbikesHelp}</span>
            </span>
            <input type="checkbox" className="h-6 w-6 shrink-0" checked={settings.preferEbikes} onChange={(e) => update({ preferEbikes: e.target.checked })} />
          </label>
        )}
        {systemId && details && details.passes.length > 0 && (
          <label className={row}>
            <span>{t.myPass}</span>
            <PassSelect systemId={systemId} details={details} className={select} />
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
        <AlertsSettings />
        {systemId && <SavedPlacesSettings systemId={systemId} />}
        <RecentPlacesSetting />
        <p className="px-4 py-3 text-sm text-slate-500">
          {isNativeApp() ? t.storageNoteNative : t.storageNote}
        </p>
        <button type="button" className={`${row} w-full text-left`} onClick={() => useAppStore.getState().setPanel('about')}>
          <span>{t.aboutLink}</span>
          <Icon name="chevronRight" size={20} />
        </button>
        {APP.instagram && (
          <a className={`${row} w-full`} href={APP.instagram.url} target="_blank" rel="noopener noreferrer" aria-label={t.instagramAria(APP.instagram.handle)}>
            <span className="flex items-center gap-2">
              <Icon name="instagram" size={20} className="shrink-0" /> {t.followInstagram}
            </span>
            <span className="text-sm text-slate-500">{APP.instagram.handle}</span>
          </a>
        )}
      </div>
    </section>
  )
}

/** The recent places offered in search and as quick destinations (all cities): how many, and a way to clear them. */
function RecentPlacesSetting() {
  const count = useAppStore((s) => s.recentPlaces.length)
  const { t } = useI18n()
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2">
      <Icon name="clock" size={20} className="shrink-0 text-slate-500" />
      <span className="min-w-0 flex-1">
        <span className="block">{t.recentPlaces}</span>
        <span className="block text-sm text-slate-500">{t.recentCount(count)}</span>
      </span>
      <button
        type="button"
        disabled={count === 0}
        aria-label={t.clearRecentAria}
        className="min-h-11 shrink-0 px-2 text-sm font-medium text-brand-700 disabled:text-slate-400 dark:text-brand-300 dark:disabled:text-slate-600"
        onClick={() => useAppStore.getState().clearRecent()}
      >
        {t.clear}
      </button>
    </div>
  )
}

/** Home, Work and favorite places for this city: set or change them by search, or remove them. */
function SavedPlacesSettings({ systemId }: { systemId: string }) {
  const all = useAppStore((s) => s.savedPlaces)
  const { t } = useI18n()
  const [editing, setEditing] = useState<SavedPlace['icon'] | null>(null)
  const saved = all.filter((p) => p.systemId === systemId)
  const home = saved.find((p) => p.icon === 'home')
  const work = saved.find((p) => p.icon === 'work')
  const favorites = saved.filter((p) => p.icon === 'star')
  const remove = (p: SavedPlace, name: string) => (
    <IconButton icon="close" label={t.remove(name)} variant="ghost" onClick={() => useAppStore.getState().removeSavedPlace(p.id)} />
  )
  const searchFor = (icon: SavedPlace['icon']) =>
    editing === icon && (
      <div className="flex items-center gap-2 px-4 pb-3">
        <div className="min-w-0 flex-1">
          <SearchBox
            key={icon}
            autoFocus
            label={t.searchToSave}
            placeholder={t.searchToSave}
            onCancel={() => setEditing(null)}
            onSelect={(p) => {
              useAppStore.getState().savePlace({ systemId, icon, label: icon === 'home' ? t.home : icon === 'work' ? t.work : p.name, place: { ...p, kind: 'saved' } })
              setEditing(null)
            }}
          />
        </div>
        <button type="button" className="min-h-11 shrink-0 px-1 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => setEditing(null)}>
          {t.cancel}
        </button>
      </div>
    )
  const homeWork = (icon: 'home' | 'work', p: SavedPlace | undefined) => {
    const name = icon === 'home' ? t.home : t.work
    return (
      <div key={icon}>
        <div className="flex min-h-14 items-center gap-3 px-4 py-2">
          <Icon name={icon} size={20} className="shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1">
            <span className="block">{name}</span>
            <span className="block truncate text-sm text-slate-500">{p ? p.place.name : t.notSet}</span>
          </span>
          <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => setEditing(icon)}>
            {p ? t.change : t.set}
          </button>
          {p && remove(p, name)}
        </div>
        {searchFor(icon)}
      </div>
    )
  }
  return (
    <section aria-label={t.savedPlaces}>
      <h3 className="px-4 pb-1 pt-4 text-sm font-medium text-slate-500">{t.savedPlaces}</h3>
      {homeWork('home', home)}
      {homeWork('work', work)}
      {favorites.map((p) => (
        <div key={p.id} className="flex min-h-12 items-center gap-3 px-4 py-1">
          <Icon name="star" size={20} className="shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate">{p.place.name}</span>
          {remove(p, p.place.name)}
        </div>
      ))}
      {editing === 'star' ? (
        searchFor('star')
      ) : (
        <button type="button" className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-medium text-brand-700 dark:text-brand-300" onClick={() => setEditing('star')}>
          <Icon name="plus" size={20} className="shrink-0" /> {t.addFavorite}
        </button>
      )}
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
        {APP.instagram && (
          <p>
            <a className="inline-flex min-h-11 items-center gap-2 font-medium text-brand-700 underline dark:text-brand-300" href={APP.instagram.url} target="_blank" rel="noopener noreferrer" aria-label={t.instagramAria(APP.instagram.handle)}>
              <Icon name="instagram" size={20} className="shrink-0" /> {t.followInstagram} ({APP.instagram.handle})
            </a>
          </p>
        )}
        <ul className="list-disc space-y-1 pl-5">
          <li>{t.creditStations(Math.round(POLL.statusAfterFeedMs / 60_000))}</li>
          <li>{t.creditMap}</li>
          <li>{t.creditRouting}</li>
          <li>{t.creditSearch}</li>
          <li>{t.creditWeather}</li>
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
