// Browse-mode panels: home (search, quick actions, saved/starred), dropped pin, station list,
// settings and about.
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { POLL } from '../../config'
import { useMeta, useNow, useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { getSystem, SYSTEMS } from '../../data/systems'
import { useReverseGeocode } from '../../geocode/hooks'
import { formatDistance, formatTimeAgo } from '../../lib/format'
import { haversine } from '../../lib/geo'
import { classifyStation } from '../../lib/stationState'
import { useAppStore } from '../../store/appStore'
import { useLocationStore } from '../../location/locationStore'
import type { Freshness } from '../../data/snapshot'
import type { Place } from '../../types'
import { AvailabilityPill } from '../primitives/Availability'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { changeCity, planRide, rideTo, startRideAt } from '../ride/rideActions'
import { canRent } from '../../lib/stationState'
import { kNearest } from '../../lib/geo'
import { SearchBox } from './SearchBox'

export function FreshnessBadge({ freshness, lastUpdatedMs }: { freshness: Freshness; lastUpdatedMs: number | undefined }) {
  const now = useNow(10_000)
  if (freshness === 'loading') return <span className="text-xs text-slate-500">Loading live data…</span>
  if (freshness === 'error') return <span className="text-xs font-medium text-red-700">Live data unavailable</span>
  const age = lastUpdatedMs ? formatTimeAgo((now - lastUpdatedMs) / 1000) : ''
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${freshness === 'stale' ? 'font-medium text-amber-700' : 'text-slate-500'}`}>
      <span className={`h-2 w-2 rounded-full ${freshness === 'stale' ? 'bg-amber-500' : 'bg-green-600'}`} aria-hidden />
      {freshness === 'stale' ? `Data may be stale (${age})` : `Live · ${age}`}
    </span>
  )
}

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <header className="flex items-center gap-2 px-4 pt-4">
      {onBack && <IconButton icon="back" label="Back" variant="ghost" onClick={onBack} />}
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
  const starredStations = (snapshot && systemId ? starred.filter((k) => k.startsWith(`${systemId}:`)).map((k) => snapshot.byId.get(k.slice(systemId.length + 1))) : []).filter((s) => !!s)
  const installed = snapshot?.stations.filter((s) => s.status?.isInstalled).length ?? 0
  const select = (p: Place) => {
    if (p.stationId) useAppStore.getState().selectStation(p.stationId)
    else rideTo(p)
  }
  if (system && snapshot && installed === 0) {
    return (
      <div className="space-y-3 p-4">
        <p className="font-medium">{system.name} has no stations in service right now (seasonal?).</p>
      </div>
    )
  }
  return (
    <div className="space-y-3 p-4">
      <SearchBox label="Search stations or places" onSelect={select} />
      {installed >= 2 && (
        <Button block size="nav" icon="bike" onClick={planRide}>
          Plan a ride
        </Button>
      )}
      <div className="flex items-center justify-between">
        <FreshnessBadge freshness={freshness} lastUpdatedMs={snapshot?.lastUpdatedMs} />
        <button type="button" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => useAppStore.getState().setPanel('list')}>
          <Icon name="list" size={18} /> Station list
        </button>
      </div>
      {saved.filter((s) => s.systemId === systemId).length > 0 && (
        <ul className="space-y-1" aria-label="Saved places">
          {saved
            .filter((s) => s.systemId === systemId)
            .map((s) => (
              <li key={s.id}>
                <button type="button" className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => rideTo(s.place)}>
                  <Icon name={s.icon} size={20} className="text-slate-500" />
                  <span className="font-medium">{s.label}</span>
                  <span className="truncate text-sm text-slate-500">{s.place.name}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      {starredStations.length > 0 && (
        <ul className="space-y-1" aria-label="Starred stations">
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
  const { snapshot } = useStationsSnapshot(systemId)
  const partySize = useAppStore((s) => s.settings.partySize)
  if (!pin) return null
  const p: Place = place ?? { kind: 'mapPick', name: 'Dropped pin', coord: pin }
  const asPlace: Place = { ...p, coord: pin }
  return (
    <section aria-label="Dropped pin" className="space-y-3 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{loading ? 'Looking up…' : p.name}</h2>
          {p.detail && <p className="text-sm text-slate-500">{p.detail}</p>}
        </div>
        <IconButton icon="close" label="Close" onClick={() => {
            useAppStore.getState().dropPin(null)
            back()
          }} />
      </header>
      <div className="grid grid-cols-2 gap-2">
        <Button icon="bike" onClick={() => rideTo(asPlace)}>
          Ride here
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            const near = snapshot ? kNearest(pin, snapshot.stations.filter((st) => canRent(st, partySize)), (st) => st.coord, 1)[0] : undefined
            if (near) startRideAt(near.item.id)
          }}
        >
          Start from nearest dock
        </Button>
        {systemId && (
          <Button variant="ghost" icon="home" onClick={() => useAppStore.getState().savePlace({ systemId, icon: 'home', label: 'Home', place: { ...asPlace, kind: 'saved' } })}>
            Save as Home
          </Button>
        )}
        {systemId && (
          <Button variant="ghost" icon="work" onClick={() => useAppStore.getState().savePlace({ systemId, icon: 'work', label: 'Work', place: { ...asPlace, kind: 'saved' } })}>
            Save as Work
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
  const sorted = useMemo(() => {
    if (!snapshot) return []
    const list = [...snapshot.stations]
    if (fix) list.sort((a, b) => haversine(fix.coord, a.coord) - haversine(fix.coord, b.coord))
    else list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }, [snapshot, fix])
  return (
    <section aria-label="Stations">
      <Header title="Stations" onBack={back} />
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
                  {fix && <span className="text-sm text-slate-500">{formatDistance(haversine(fix.coord, st.coord), units)}</span>}
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
  // Labels may wrap and selects are capped, so no row is ever wider than the screen (Safari sizes a
  // native select to its longest option).
  const row = 'flex min-h-14 min-w-0 items-center justify-between gap-4 px-4 py-2 [&>span]:min-w-0'
  const select = 'min-h-11 min-w-0 max-w-[55%] shrink truncate rounded-lg bg-slate-100 px-2 dark:bg-slate-800'
  return (
    <section aria-label="Settings">
      <Header title="Settings" onBack={back} />
      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        <label className={row}>
          <span>City</span>
          <select className={select} value={systemId ?? ''} onChange={(e) => changeCity(e.target.value)}>
            {[...SYSTEMS]
              .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.city || s.name}
                  {s.active ? '' : ' (closed for the season)'}
                </option>
              ))}
          </select>
        </label>
        <label className={row}>
          <span>Units</span>
          <select className={select} value={settings.units} onChange={(e) => update({ units: e.target.value === 'metric' ? 'metric' : 'imperial' })}>
            <option value="imperial">Miles / feet</option>
            <option value="metric">Kilometers / meters</option>
          </select>
        </label>
        <label className={row}>
          <span>Riders</span>
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
            <span>My pass</span>
            <select
              className={select}
              value={pass?.planId ?? ''}
              onChange={(e) => {
                const plan = details.passes.find((p) => p.id === e.target.value)
                useAppStore.getState().setPassChoice(systemId, plan ? { planId: plan.id, includedMinutes: plan.includedMinutes } : { planId: null, includedMinutes: details.defaultIncludedMinutes })
              }}
            >
              <option value="">Not sure{details.defaultIncludedMinutes ? ` (${details.defaultIncludedMinutes} min)` : ''}</option>
              {details.passes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.includedMinutes ? ` · ${p.includedMinutes} min/ride` : ' · per minute'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={row}>
          <span>I have the BCycle app and a pass</span>
          <input type="checkbox" className="h-6 w-6" checked={settings.setupConfirmed} onChange={(e) => update({ setupConfirmed: e.target.checked })} />
        </label>
        <label className={row}>
          <span>Map style</span>
          <select className={select} value={settings.mapStyle} onChange={(e) => update({ mapStyle: e.target.value === 'dark' ? 'dark' : e.target.value === 'light' ? 'light' : 'auto' })}>
            <option value="auto">Automatic</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <p className="px-4 py-3 text-sm text-slate-500">
          Saved places, recent destinations, starred stations and your current ride are stored on this device only. Clearing this site’s data (cookies and site data) removes them.
        </p>
        <button type="button" className={`${row} w-full text-left`} onClick={() => useAppStore.getState().setPanel('about')}>
          <span>About & attributions</span>
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
  return (
    <section aria-label="About" className="text-sm">
      <Header title="About" onBack={() => useAppStore.getState().setPanel('settings')} />
      <div className="space-y-3 p-4">
        <p>Live BCycle station availability and bike-share ride planning, with turn-by-turn directions in Google Maps. Not affiliated with BCycle / Revolution.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Station data: BCycle GBFS feeds (refreshed about every {Math.round(POLL.statusAfterFeedMs / 60_000)} min)</li>
          <li>Map: © OpenStreetMap contributors, OpenFreeMap, OpenMapTiles</li>
          <li>Routing: Valhalla &amp; OSRM servers by FOSSGIS e.V.</li>
          <li>Search: Photon by komoot</li>
        </ul>
        <p>
          <a className="font-medium text-brand-700 underline dark:text-brand-300" href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">
            Report a map problem
          </a>
        </p>
        {meta?.contactEmail && (
          <p>
            Operator contact:{' '}
            <a className="underline" href={`mailto:${meta.contactEmail}`}>
              {meta.contactEmail}
            </a>
          </p>
        )}
        {details?.phone && <p>{details.name} support: {details.phone}</p>}
        {meta && <p className="text-slate-500">Version {meta.version}</p>}
      </div>
    </section>
  )
}
