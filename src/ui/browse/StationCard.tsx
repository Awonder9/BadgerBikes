// Station details: status, live counts + trend, walk estimate, actions and the BCycle app hand-off.
import { useShallow } from 'zustand/react/shallow'
import { useNow, useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { getTrend, trendDelta } from '../../data/trend'
import { formatDuration, formatTimeAgo } from '../../lib/format'
import { classifyStation, fleetComposition } from '../../lib/stationState'
import { appLaunchUrl, safeAppDiscoveryUri, safeExternalUrl, LINK_HOSTS } from '../../lib/urlParams'
import { estimateBetween } from '../../routing/estimates'
import { useAppStore } from '../../store/appStore'
import { useLocationStore } from '../../location/locationStore'
import type { Station, SystemDetails } from '../../types'
import { AvailabilityPill } from '../primitives/Availability'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { rideTo, startRideAt } from '../ride/rideActions'

export function platform(): 'ios' | 'android' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

function statusBanner(st: Station): string | null {
  const s = st.status
  if (!s || !s.isInstalled) return 'Out of service: this station is offline.'
  if (!s.isRenting && !s.isReturning) return 'Not renting or accepting returns right now.'
  if (!s.isRenting) return "Not renting: bikes can't be unlocked here right now."
  if (!s.isReturning) return 'Not accepting returns right now.'
  return null
}

export function AppHandoff({ details, compact }: { details: SystemDetails | undefined; compact?: boolean }) {
  const setupConfirmed = useAppStore((s) => s.settings.setupConfirmed)
  const p = platform()
  if (p === 'desktop') return <p className="text-sm text-slate-500">Unlock bikes with the BCycle app on your phone.</p>
  const link = details?.rentalApps[p]
  const discovery = safeAppDiscoveryUri(link?.discoveryUri)
  const store = safeExternalUrl(link?.storeUri, LINK_HOSTS.appStores)
  if (!discovery && !store) return null
  const launch = appLaunchUrl(p, link?.discoveryUri ?? null, store)
  return (
    <div className={`grid grid-cols-2 gap-2 ${compact ? '' : 'pt-1'}`}>
      {/* A real link (not a script redirect): the most reliable way to hand off to an installed app. */}
      {launch && (
        <a className={`flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 font-medium ${setupConfirmed ? 'bg-brand-700 text-white' : 'ring-1 ring-slate-300 dark:ring-slate-600'}`} href={launch}>
          <Icon name="external" size={20} className="shrink-0" /> Open BCycle
        </a>
      )}
      {store && (
        <a className={`flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 font-medium ring-1 ring-slate-300 dark:ring-slate-600 ${launch ? '' : 'col-span-2'}`} href={store} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={20} className="shrink-0" /> Get BCycle
        </a>
      )}
    </div>
  )
}

export function StationCard() {
  const { systemId, selectedId, mapMode, partySize, starred, watched } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, selectedId: s.selectedStationId, mapMode: s.mapMode, partySize: s.settings.partySize, starred: s.starredStations, watched: s.watchedStation })),
  )
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const { details } = useSystemDetails(systemId)
  const fix = useLocationStore((s) => s.fix)
  const now = useNow(10_000)
  const st = selectedId ? snapshot?.byId.get(selectedId) : undefined
  const close = () => {
    useAppStore.getState().selectStation(null)
    useAppStore.getState().setPanel('browse')
  }
  if (!st || !systemId || !snapshot) {
    return (
      <div className="p-4 text-slate-500">
        Station not found.{' '}
        <button type="button" className="underline" onClick={close}>
          Back
        </button>
      </div>
    )
  }
  const a = classifyStation(st, partySize)
  const mixed = fleetComposition(snapshot.stations) === 'mixed'
  const banner = statusBanner(st)
  const trendKind = mapMode
  const trend = trendDelta(getTrend(systemId, st.id), trendKind, 10 * 60_000)
  const walk = fix ? estimateBetween(fix.coord, st.coord, 'walk') : null
  const isStarred = starred.includes(`${systemId}:${st.id}`)
  const want: 'bikes' | 'docks' = mapMode
  const watching = watched?.stationId === st.id

  const bikes = <AvailabilityPill kind="bikes" count={st.status?.bikes ?? 0} state={a.bikeState} ebikes={mixed ? st.status?.ebikes ?? null : null} size={mapMode === 'bikes' ? 'lg' : 'md'} />
  const docks = <AvailabilityPill kind="docks" count={st.status?.docks ?? 0} state={a.dockState} size={mapMode === 'docks' ? 'lg' : 'md'} />

  return (
    <section aria-label={`Station ${st.name}`} className="space-y-3 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-tight">{st.name}</h2>
          {st.address && st.address !== st.name && <p className="truncate text-sm text-slate-500">{st.address}</p>}
        </div>
        <IconButton icon="star" label={isStarred ? 'Unstar station' : 'Star station'} pressed={isStarred} variant={isStarred ? 'primary' : 'secondary'} onClick={() => useAppStore.getState().toggleStar(systemId, st.id)} />
        <IconButton icon="close" label="Close" onClick={close} />
      </header>
      {banner && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <Icon name="warning" size={16} className="mr-1 inline" />
          {banner}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {mapMode === 'bikes' ? (
          <>
            {bikes}
            {docks}
          </>
        ) : (
          <>
            {docks}
            {bikes}
          </>
        )}
        {st.hasKiosk && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">Kiosk</span>}
      </div>
      <p className="text-sm text-slate-500">
        Updated {formatTimeAgo((now - snapshot.lastUpdatedMs) / 1000)}
        {trend && trend.delta !== 0 && (
          <span className="ml-2 font-medium text-slate-700 dark:text-slate-300">
            {trend.delta < 0 ? '▼' : '▲'}
            {Math.abs(trend.delta)} {trendKind} in {Math.round(trend.spanMs / 60_000)} min
          </span>
        )}
        {walk && <span className="ml-2">· ~{formatDuration(walk.duration)} walk</span>}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button icon="bike" className="whitespace-nowrap px-2" onClick={() => startRideAt(st.id)} disabled={a.bikeState === 'unavailable' || a.bikeState === 'none'}>
          Start ride here
        </Button>
        <Button variant="secondary" icon="dock" className="whitespace-nowrap px-2" onClick={() => rideTo({ kind: 'station', name: st.name, coord: st.coord, stationId: st.id })}>
          Ride to here
        </Button>
        {/* Alerts when more free up than right now, so it never fires the moment it's tapped. */}
        <Button
          variant={watching ? 'primary' : 'secondary'}
          icon="bell"
          className="col-span-2 whitespace-nowrap px-2"
          onClick={() => useAppStore.getState().watchStation(watching ? null : { stationId: st.id, want, baseline: want === 'bikes' ? (st.status?.bikes ?? 0) : (st.status?.docks ?? 0) })}
          aria-pressed={watching}
        >
          {watching ? 'Watching — tap to stop' : `Tell me when a ${want === 'bikes' ? 'bike' : 'dock'} frees up`}
        </Button>
      </div>
      <AppHandoff details={details} />
    </section>
  )
}
