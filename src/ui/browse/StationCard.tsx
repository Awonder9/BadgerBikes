// Station details: status, live counts + trend, walk estimate, actions and the BCycle app hand-off.
import { useShallow } from 'zustand/react/shallow'
import { useNow, useStationsSnapshot, useSystemDetails } from '../../data/hooks'
import { getTrend, trendDelta } from '../../data/trend'
import { formatDuration, formatTimeAgo } from '../../lib/format'
import { classifyStation, fleetComposition } from '../../lib/stationState'
import { appLaunchUrl, buildStationShareUrl, safeExternalUrl, LINK_HOSTS } from '../../lib/urlParams'
import { directionsFromHereUrl } from '../../ride/googleMaps'
import { estimateBetween } from '../../routing/estimates'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import type { Messages } from '../../i18n'
import { useLocationStore } from '../../location/locationStore'
import { rideUnderWay, useRideStore } from '../../ride/rideStore'
import type { Station, SystemDetails } from '../../types'
import { AvailabilityPill } from '../primitives/Availability'
import { Button, ButtonLink, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { ShareButton } from '../primitives/ShareButton'
import { isNativeApp, platform, shareOrigin } from '../platform'
import { rideTo, startRideAt } from '../ride/rideActions'
import { countUse } from '../usage'

function statusBanner(st: Station, t: Messages): string | null {
  const s = st.status
  if (!s || !s.isInstalled) return t.statusOffline
  if (!s.isRenting && !s.isReturning) return t.statusClosed
  if (!s.isRenting) return t.statusNotRenting
  if (!s.isReturning) return t.statusNotReturning
  return null
}

/**
 * One "BCycle" button. iPhone: BCycle's App Store page (shows Open when installed, Get when not) — the
 * app answers no web link, so it can't be opened directly. Android: launches the app, or its Play Store
 * page when it isn't installed. In our own Android app its Play Store page too: only Chrome can open the
 * intent:// link that launches it (the app's web view hands it to the system, which drops it).
 */
export function AppHandoff({ details }: { details: SystemDetails | undefined }) {
  const p = platform()
  const { t } = useI18n()
  if (p === 'desktop') return <p className="text-sm text-slate-500">{t.unlockOnPhone}</p>
  const link = details?.rentalApps[p]
  const store = safeExternalUrl(link?.storeUri, LINK_HOSTS.appStores)
  const href = (p === 'android' && isNativeApp() ? null : appLaunchUrl(p, link?.discoveryUri ?? null, store)) ?? store
  if (!href) return null
  const external = href.startsWith('https:')
  return (
    <a
      className="flex min-h-11 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 font-medium ring-1 ring-slate-300 dark:ring-slate-600"
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <Icon name="external" size={20} className="shrink-0" /> BCycle
    </a>
  )
}

export function StationCard() {
  const { systemId, selectedId, mapMode, partySize, starred, watched } = useAppStore(
    useShallow((s) => ({ systemId: s.systemId, selectedId: s.selectedStationId, mapMode: s.mapMode, partySize: s.settings.partySize, starred: s.starredStations, watched: s.watchedStation })),
  )
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const { details } = useSystemDetails(systemId)
  const fix = useLocationStore((s) => s.fix)
  // Mid-ride a dock's card is where "Nearest open dock" and a tap on the map lead: it must not re-plan the ride.
  const riding = useRideStore(rideUnderWay)
  const now = useNow(10_000)
  const { t, lang } = useI18n()
  const st = selectedId ? snapshot?.byId.get(selectedId) : undefined
  const close = () => {
    useAppStore.getState().selectStation(null)
    useAppStore.getState().setPanel('browse')
  }
  if (!st || !systemId || !snapshot) {
    return (
      <div className="p-4 text-slate-500">
        {t.stationNotFound}{' '}
        <button type="button" className="underline" onClick={close}>
          {t.back}
        </button>
      </div>
    )
  }
  const a = classifyStation(st, partySize)
  const mixed = fleetComposition(snapshot.stations) === 'mixed'
  const banner = statusBanner(st, t)
  const trendKind = mapMode
  const trend = trendDelta(getTrend(systemId, st.id), trendKind, 10 * 60_000)
  const walk = fix ? estimateBetween(fix.coord, st.coord, 'walk') : null
  const isStarred = starred.includes(`${systemId}:${st.id}`)
  const want: 'bikes' | 'docks' = mapMode
  const watching = watched?.stationId === st.id

  const bikes = <AvailabilityPill kind="bikes" count={st.status?.bikes ?? 0} state={a.bikeState} ebikes={mixed ? st.status?.ebikes ?? null : null} size={mapMode === 'bikes' ? 'lg' : 'md'} />
  const docks = <AvailabilityPill kind="docks" count={st.status?.docks ?? 0} state={a.dockState} size={mapMode === 'docks' ? 'lg' : 'md'} />

  return (
    <section aria-label={t.stationAria(st.name)} className="space-y-3 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-tight">{st.name}</h2>
          {st.address && st.address !== st.name && <p className="truncate text-sm text-slate-500">{st.address}</p>}
        </div>
        <IconButton icon="star" label={isStarred ? t.unstar : t.star} pressed={isStarred} variant={isStarred ? 'primary' : 'secondary'} onClick={() => useAppStore.getState().toggleStar(systemId, st.id)} />
        <IconButton icon="close" label={t.close} onClick={close} />
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
        {st.hasKiosk && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t.kiosk}</span>}
      </div>
      <p className="text-sm text-slate-500">
        {t.updated(formatTimeAgo((now - snapshot.lastUpdatedMs) / 1000, lang))}
        {trend && trend.delta !== 0 && (
          <span className="ml-2 font-medium text-slate-700 dark:text-slate-300">
            {trend.delta < 0 ? '▼' : '▲'}
            {t.trend(Math.abs(trend.delta), trendKind, Math.round(trend.spanMs / 60_000))}
          </span>
        )}
        {walk && <span className="ml-2">{t.walkAbout(formatDuration(walk.duration, lang))}</span>}
      </p>
      {/* All action rows share one 8 px rhythm. */}
      <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Button icon="bike" className="whitespace-nowrap px-2" onClick={() => startRideAt(st)} disabled={a.bikeState === 'unavailable' || a.bikeState === 'none'}>
          {t.startRideHere}
        </Button>
        {riding ? (
          // Mid-ride: bike directions from where the rider is (like the ride card's other docks), keeping the plan,
          // the ride timer and its alerts. Re-planning would start from the first dock and clear the timer.
          <ButtonLink variant="secondary" icon="dock" className="whitespace-nowrap px-2" href={directionsFromHereUrl(st.coord, 'bicycling')} aria-label={t.bikeDirectionsAria(st.name)}>
            {t.rideToHere}
          </ButtonLink>
        ) : (
          <Button variant="secondary" icon="dock" className="whitespace-nowrap px-2" onClick={() => rideTo({ kind: 'station', name: st.name, coord: st.coord, stationId: st.id })}>
            {t.rideToHere}
          </Button>
        )}
        {/* Alerts when more free up than right now, so it never fires the moment it's tapped. */}
        <Button
          variant={watching ? 'primary' : 'secondary'}
          icon="bell"
          className="col-span-2 whitespace-nowrap px-2"
          onClick={() => useAppStore.getState().watchStation(watching ? null : { stationId: st.id, want, baseline: want === 'bikes' ? (st.status?.bikes ?? 0) : (st.status?.docks ?? 0) })}
          aria-pressed={watching}
        >
          {watching ? t.watching : t.tellMeWhen(want)}
        </Button>
        <a
          href={directionsFromHereUrl(st.coord, 'walking')}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => countUse('directions')}
          aria-label={t.directionsAria(st.name)}
          className="flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 font-medium ring-1 ring-slate-300 dark:ring-slate-600"
        >
          <Icon name="walk" size={20} className="shrink-0" /> {t.directions}
        </a>
        <ShareButton
          title={t.shareStationTitle(st.name)}
          url={() => buildStationShareUrl(shareOrigin(), systemId, st.id)}
          className="flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 font-medium ring-1 ring-slate-300 dark:ring-slate-600"
        />
      </div>
      <AppHandoff details={details} />
      </div>
    </section>
  )
}
