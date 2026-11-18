// Ride planner: start dock → destination → route option → docks along the route → open in Google Maps,
// plus the ride-in-progress card once the rider has opened a part.
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BIKE_ROUTING, RIDE } from '../../config'
import { useNow, useStationsSnapshot } from '../../data/hooks'
import { bikeMix, formatDistance, formatDuration, unitWord } from '../../lib/format'
import { bboxOf } from '../../lib/geo'
import { canRent, classifyCount, classifyStation } from '../../lib/stationState'
import { useRouteDetails } from '../../data/routeDetails'
import { PATH_COLORS } from '../../map/colors'
import { buildRideShareUrl } from '../../lib/urlParams'
import { gpxFileName, rideGpx } from '../../ride/gpx'
import { waitForFix } from '../../location/locationStore'
import { useMapApiGetter } from '../../map/mapApiContext'
import { chooseRoute, docksAlong, loadRideRoute, useRideStore } from '../../ride/rideStore'
import { rideSeconds, type RouteDock } from '../../ride/stationsAlongRoute'
import { sameRoute } from '../../routing/sameRoute'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import type { Place, Station } from '../../types'
import { SearchBox } from '../browse/SearchBox'
import { AvailabilityPill } from '../primitives/Availability'
import { IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { Spinner } from '../primitives/Spinner'
import { RideStatusCard } from './RideProgress'
import { useRidePlan, type RidePlan } from './useRidePlan'

export function RidePlannerPanel() {
  const { systemId, units, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, units: s.settings.units, partySize: s.settings.partySize })))
  const ride = useRideStore()
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const plan = useRidePlan()
  const { start, along, end, rideParts, walkLink, nextPart, optimizedIds, maxRideMinutes } = plan
  const getMap = useMapApiGetter()
  const { t, lang } = useI18n()

  // Frame the whole route once it arrives.
  useEffect(() => {
    const b = ride.route ? bboxOf(ride.route.geometry) : null
    if (b) getMap()?.fitBounds(b, { maxZoom: 16 })
  }, [ride.route, getMap])

  // Starting from a place: use the best pickup dock for this trip until the rider picks one. Only before
  // routing (new start or destination), so live count changes never re-route a plan on screen.
  const bestPickup = plan.pickups[0]?.station.id
  useEffect(() => {
    const r = useRideStore.getState()
    if (r.origin && !r.origin.stationId && !r.pickupPinned && bestPickup && r.openedParts.length === 0 && (r.startId === null || r.status === 'idle')) r.autoPickup(bestPickup)
  }, [bestPickup, ride.status, ride.destination, ride.origin, ride.startId])

  // Route whenever both ends are known.
  useEffect(() => {
    if (systemId && snapshot && ride.startId && ride.destination && ride.status === 'idle') void loadRideRoute(systemId, snapshot, units, partySize)
  }, [systemId, snapshot, ride.startId, ride.destination, ride.status, units, partySize])

  // The max-ride setting changed since these stops were picked (e.g. in Settings): re-pick the optimized
  // stops, unless mid-ride. Reopening the planner without a change keeps the rider's own choices.
  useEffect(() => {
    const r = useRideStore.getState()
    if (snapshot && r.status === 'ready' && r.openedParts.length === 0 && r.stopsForMaxRide !== maxRideMinutes) chooseRoute(r.routeIndex, snapshot, partySize)
  }, [maxRideMinutes, snapshot, partySize])

  const dest = ride.destination
  const dockCounts = useMemo(
    () => (snapshot && start && dest ? ride.routes.map((r) => docksAlong(r, snapshot, start.id, dest, partySize).filter((s) => s.reason === 'onRoute' && (s.station.status?.docks ?? 0) > 0).length) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maxRideMinutes is read inside docksAlong
    [ride.routes, snapshot, start, dest, partySize, maxRideMinutes],
  )
  const order = along.map((s) => s.station.id)
  const riding = ride.openedParts.length > 0

  return (
    <section aria-label={t.planARide} className="space-y-3 p-4">
      <header className="flex items-center gap-1">
        <IconButton icon="back" label={t.back} variant="ghost" onClick={() => useAppStore.getState().setPanel('browse')} />
        <h2 className="flex-1 text-xl font-semibold">{riding ? t.yourRide : t.planARide}</h2>
        {systemId && start && dest && ride.status === 'ready' && <ShareButton systemId={systemId} startId={start.id} destination={dest} routeIndex={ride.routeIndex} />}
        {(ride.origin || ride.startId || ride.destination) && (
          <button
            type="button"
            aria-label={t.clearPlan}
            className="ml-1 inline-flex min-h-11 items-center gap-1 rounded-full bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 active:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600 dark:active:bg-slate-800"
            onClick={ride.reset}
          >
            <Icon name="close" size={16} className="shrink-0" /> {t.clear}
          </button>
        )}
      </header>

      <RideStatusCard plan={plan} />

      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-500">{t.stepStart}</p>
        {ride.origin && !ride.origin.stationId ? <StartFromPlace plan={plan} partySize={partySize} units={units} /> : start ? <StartDock station={start} partySize={partySize} /> : <StartPicker />}
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-500">{t.stepWhereTo}</p>
        <SearchBox key={`dest:${dest?.name ?? ''}`} label={t.destination} placeholder={t.destinationPlaceholder} initialValue={dest?.name ?? ''} onSelect={(p) => ride.setDestination(p)} />
        {!dest && <QuickDestinations />}
      </div>

      {ride.status === 'routing' && (
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300" role="status">
          <Spinner className="text-brand-600" />
          {t.findingRoute}
        </p>
      )}
      {ride.status === 'error' && ride.error && <RouteError error={ride.error} />}

      {ride.status === 'ready' && ride.route && start && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-500">{t.stepChooseRoute}</p>
            <div role="radiogroup" aria-label={t.routeOptions} className="grid grid-cols-3 gap-2">
              {ride.routes.map((r, i) => {
                const opt = BIKE_ROUTING.options[i]
                const label = opt ? (t.routeOption[opt.key] ?? opt.label) : t.optionN(i + 1)
                const dup = ride.routes.findIndex((o, j) => j < i && sameRoute(o.geometry, r.geometry, BIKE_ROUTING.duplicateRouteMeters))
                const dupOpt = dup >= 0 ? BIKE_ROUTING.options[dup] : undefined
                const sameAs = dupOpt ? (t.routeOption[dupOpt.key] ?? dupOpt.label) : null
                return (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={i === ride.routeIndex}
                    aria-label={t.routeAria(label, formatDuration(r.duration, lang), formatDistance(r.distance, units, lang), sameAs, dockCounts[i] ?? 0)}
                    onClick={() => snapshot && chooseRoute(i, snapshot, partySize)}
                    className={`flex min-h-20 flex-col items-center justify-center rounded-xl px-1 py-2 text-center ring-1 ${i === ride.routeIndex ? 'bg-brand-50 ring-2 ring-brand-700 dark:bg-brand-900' : 'ring-slate-300 dark:ring-slate-600'}`}
                  >
                    <span className="whitespace-nowrap text-[13px] font-semibold leading-tight">{label}</span>
                    <span className="mt-1 text-lg font-bold leading-tight">~{formatDuration(r.duration, lang)}</span>
                    <span className={`text-xs ${i === ride.routeIndex ? 'text-slate-600 dark:text-slate-300' : 'text-slate-500'}`}>{sameAs ? t.sameAs(sameAs) : formatDistance(r.distance, units, lang)}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <TripSummary plan={plan} units={units} />
          <RouteDetailsCard systemId={systemId} units={units} />

          {along.length === 0 ? (
            <>
              <p className="text-sm font-medium text-slate-500">{t.stepStops}</p>
              <p className="text-sm text-amber-800 dark:text-amber-300">{t.noDocksOnRoute}</p>
            </>
          ) : (
            <>
              <div>
                <p className="text-sm font-medium text-slate-500">{t.stepOptimized}</p>
                <p className="text-xs text-slate-500">
                  {t.optimizedHelp(maxRideMinutes)}
                </p>
              </div>
              <DockList docks={along.filter((d) => optimizedIds.has(d.station.id))} order={order} plan={plan} partySize={partySize} units={units} />
              {along.some((d) => !optimizedIds.has(d.station.id)) && (
                <>
                  <div>
                    <p className="text-sm font-medium text-slate-500">{t.optionalStops}</p>
                    <p className="text-xs text-slate-500">{t.optionalHelp}</p>
                  </div>
                  <DockList docks={along.filter((d) => !optimizedIds.has(d.station.id))} order={order} plan={plan} partySize={partySize} units={units} />
                </>
              )}
            </>
          )}

          {rideParts.length > 0 && start && end && ride.route && <ExactRouteFile plan={plan} />}

          {rideParts.length > 0 ? (
            <div className="sticky bottom-0 -mx-4 -mb-[calc(1rem+env(safe-area-inset-bottom))] space-y-1 border-t border-slate-200 bg-white px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 dark:border-slate-800 dark:bg-slate-950">
              {/* Reaches the bottom edge of the screen: the negative margin covers the panel's bottom padding and the
                  home-bar spacer after it; the footer pads itself so the buttons stay clear of the home bar. */}
              {rideParts.length > 1 && (
                <p className="text-xs leading-snug text-slate-500">
                  {nextPart === null
                    ? t.allPartsOpened
                    : riding
                      ? t.nextPart(nextPart + 1, rideParts[nextPart]?.endLabel ?? null)
                      : t.googleStopLimit}
                </p>
              )}
              <p className="text-xs leading-snug text-slate-500">
                {t.maxBetweenDocks(maxRideMinutes)} ·{' '}
                <button type="button" className="font-medium text-brand-700 underline dark:text-brand-300" onClick={() => useAppStore.getState().setPanel('settings')}>
                  {t.change}
                </button>
              </p>
              {(() => {
                // Up to 6 buttons share one row, shrinking text, icons and padding past 4 so labels still fit.
                // More than 6: split into balanced rows of at most 4 at full size.
                const buttons = rideParts.length + (plan.walkToDock ? 1 : 0) + (walkLink ? 1 : 0)
                const rows = buttons <= 6 ? 1 : Math.ceil(buttons / 4)
                const perRow = Math.ceil(buttons / rows)
                const tier = perRow <= 4 ? 0 : perRow === 5 ? 1 : 2
                const walkCls = ['px-2.5 text-sm gap-1', 'px-1.5 text-xs gap-0.5', 'px-1 text-[11px] gap-0.5'][tier]
                const walkIcon = [18, 15, 13][tier] ?? 18
                const bikeCls = ['px-1.5 gap-1', 'px-1 text-sm gap-0.5', 'px-0.5 text-xs gap-0.5'][tier]
                const bikeIcon = [16, 14, 12][tier] ?? 16
                const items = [
                plan.walkToDock && (
                  <a
                    key="walk-to-dock"
                    href={plan.walkToDock.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => ride.openWalkToDock()}
                    aria-label={t.walkToDockAria(start.name, ride.walkToDockOpened)}
                    className={`flex min-h-12 shrink-0 items-center justify-center whitespace-nowrap rounded-xl bg-white font-medium ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600 ${walkCls}`}
                  >
                    <Icon name={ride.walkToDockOpened ? 'check' : 'walk'} size={walkIcon} className="shrink-0" /> {t.dockButton}
                  </a>
                ),
                ...rideParts.map((l, i) => {
                  const done = ride.openedParts.includes(i)
                  const isNext = i === nextPart
                  return (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t.partAria(rideParts.length === 1 ? t.openInGoogleMaps : t.partN(i + 1), l.endLabel, done)}
                      onClick={() => {
                        // Walking to the dock first: the timer waits for "I've unlocked a bike".
                        ride.markPartOpened(i, l.fromDock, !(i === 0 && plan.walkToDock))
                        // The last link of the trip: stop saving the plan on the device.
                        if (!walkLink && i === rideParts.length - 1) ride.finishPlan()
                      }}
                      className={`flex min-h-12 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl font-semibold ${bikeCls} ${
                        done && !isNext ? 'bg-white text-brand-800 ring-1 ring-brand-700 dark:bg-slate-900 dark:text-brand-200' : 'bg-brand-700 text-white'
                      } ${isNext && riding ? 'ring-4 ring-brand-300 dark:ring-brand-600' : ''}`}
                    >
                      <Icon name={done ? 'check' : 'external'} size={bikeIcon} className="shrink-0" /> {rideParts.length === 1 ? t.openInGoogleMaps : t.partN(i + 1)}
                    </a>
                  )
                }),
                walkLink && (
                  <a key="walk-to-destination" href={walkLink.url} target="_blank" rel="noopener noreferrer" onClick={() => ride.finishPlan()} aria-label={t.walkToDestinationAria} className={`flex min-h-12 shrink-0 items-center justify-center whitespace-nowrap rounded-xl bg-white font-medium ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600 ${walkCls}`}>
                    <Icon name="walk" size={walkIcon} className="shrink-0" /> {t.walk}
                  </a>
                ),
                ].filter(Boolean)
                const gap = tier ? 'gap-1' : 'gap-1.5'
                return (
                  <div className={`flex flex-col ${gap}`}>
                    {Array.from({ length: rows }, (_, r) => (
                      <div key={r} className={`flex ${gap}`}>
                        {items.slice(r * perRow, (r + 1) * perRow)}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          ) : (
            along.length > 0 && <p className="text-sm text-slate-500">{t.keepOneDock}</p>
          )}
        </>
      )}
    </section>
  )
}

function StartDock({ station, partySize, canChange = true }: { station: Station; partySize: number; canChange?: boolean }) {
  const { t, lang } = useI18n()
  const s = station.status
  const mix = s && s.ebikes !== null && s.classic !== null && s.bikes > 0 ? bikeMix(s.ebikes, s.classic, lang) : null
  return (
    <>
      <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
        <Icon name="bike" size={20} className="shrink-0 text-brand-700" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium leading-snug">{station.name}</span>
          {mix && <span className="block text-sm text-slate-500">{mix}</span>}
        </span>
        <AvailabilityPill kind="bikes" count={s?.bikes ?? 0} state={classifyStation(station, partySize).bikeState} size="sm" />
        {canChange && (
          <button type="button" className="min-h-11 px-2 text-sm text-brand-700 dark:text-brand-300" onClick={() => useRideStore.getState().setStart(null)}>
            {t.change}
          </button>
        )}
      </div>
      {!canRent(station, partySize) && <p className="text-sm text-amber-800 dark:text-amber-300">{t.noBikesAtDock}</p>}
    </>
  )
}

/** No start yet: my location, a searched place or dock, or a dock tapped on the map. */
function StartPicker() {
  const systemId = useAppStore((s) => s.systemId)
  const { snapshot } = useStationsSnapshot(systemId)
  const [locating, setLocating] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const { t } = useI18n()
  const fromHere = async () => {
    setMsg(null)
    setLocating(true)
    const here = await waitForFix()
    setLocating(false)
    if (!here) return setMsg(t.locationUnavailable)
    useRideStore.getState().setOrigin({ kind: 'myLocation', name: t.myLocation, coord: here })
  }
  return (
    <>
      <button
        type="button"
        disabled={locating || !snapshot}
        onClick={() => void fromHere()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-3 font-semibold text-white disabled:opacity-60"
      >
        {locating ? <Spinner /> : <Icon name="locate" size={20} />}
        {locating ? t.findingYou : t.startFromMyLocation}
      </button>
      {msg && <p className="text-sm text-amber-800 dark:text-amber-300">{msg}</p>}
      <SearchBox key="start" label={t.start} placeholder={t.startPlaceholder} onSelect={(p) => useRideStore.getState().setOrigin(p)} />
    </>
  )
}

/** Starting from a place: where you start, the dock to walk to, and other nearby docks to choose from. */
function StartFromPlace({ plan, partySize, units }: { plan: RidePlan; partySize: number; units: 'imperial' | 'metric' }) {
  const { origin, start, walkToDock, pickups } = plan
  const { t, lang } = useI18n()
  if (!origin) return null
  const others = pickups.filter((p) => p.station.id !== start?.id)
  return (
    <>
      <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
        <Icon name={origin.kind === 'myLocation' ? 'locate' : 'pin'} size={20} className="shrink-0 text-brand-700" />
        <span className="line-clamp-2 min-w-0 flex-1 font-medium leading-snug">{origin.kind === 'myLocation' ? t.myLocation : origin.name}</span>
        <button type="button" className="min-h-11 px-2 text-sm text-brand-700 dark:text-brand-300" onClick={() => useRideStore.getState().setStart(null)}>
          {t.change}
        </button>
      </div>
      {start ? (
        <>
          <p className="flex items-center gap-1.5 pt-1 text-sm text-slate-600 dark:text-slate-300">
            <Icon name="walk" size={16} className="shrink-0" />
            {walkToDock ? t.walkToPickUp(formatDuration(walkToDock.seconds, lang), formatDistance(walkToDock.meters, units, lang)) : t.pickUpAt}
          </p>
          <StartDock station={start} partySize={partySize} canChange={false} />
          {others.length > 0 && (
            <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 pt-1" aria-label={t.otherStartDocks}>
              {others.map((o) => (
                <li key={o.station.id} className="shrink-0">
                  <button
                    type="button"
                    className="flex min-h-10 max-w-[15rem] items-center gap-1.5 rounded-full bg-slate-100 px-3 text-sm dark:bg-slate-800"
                    onClick={() => useRideStore.getState().setStart(o.station.id)}
                  >
                    <span className="truncate font-medium">{o.station.name}</span>
                    <span className="shrink-0 text-slate-500">
                      · {formatDuration(o.walkS, lang)} · {t.count(o.station.status?.bikes ?? 0, 'bikes')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-sm text-amber-800 dark:text-amber-300">{t.noDockNearby}</p>
      )}
    </>
  )
}

function DockList({ docks, order, plan, partySize, units }: { docks: readonly RouteDock[]; order: readonly string[]; plan: RidePlan; partySize: number; units: 'imperial' | 'metric' }) {
  const stopIds = useRideStore((s) => s.stopIds)
  const { end, segments, electric, pace, maxRideMinutes } = plan
  const { t, lang } = useI18n()
  return (
    <ul className="divide-y divide-slate-200 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
      {docks.map((s) => {
        const checked = stopIds.includes(s.station.id)
        const isEnd = end?.station.id === s.station.id
        const docksFree = s.station.status?.docks ?? 0
        const accepts = !!s.station.status?.isReturning && docksFree > 0
        const seg = segments.find((g) => g.toId === s.station.id)
        return (
          <li key={s.station.id}>
            <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
              <input type="checkbox" className="h-5 w-5 shrink-0" checked={checked} onChange={() => useRideStore.getState().toggleStop(s.station.id, order)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.station.name}</span>
                <span className="block text-sm text-slate-500">
                  {t.intoRide(formatDuration(rideSeconds(s.along, electric, pace), lang), formatDistance(s.offset, units, lang))}
                  {isEnd && <span className="ml-1 font-semibold text-brand-700 dark:text-brand-300">{t.rideEndsHere}</span>}
                </span>
                {s.reason === 'redock' && <span className="block text-sm text-slate-600 dark:text-slate-300">{t.offRouteRedock(maxRideMinutes)}</span>}
                {s.reason === 'nearDestination' && <span className="block text-sm text-slate-600 dark:text-slate-300">{t.offRouteNearDestination}</span>}
                {checked && seg?.overIncluded && <span className="block text-sm text-amber-800 dark:text-amber-300">{t.rideOverMax(maxRideMinutes)}</span>}
                {checked && !accepts && <span className="block text-sm text-red-700 dark:text-red-400">{t.noOpenDocks}</span>}
              </span>
              <AvailabilityPill kind="docks" count={docksFree} state={accepts ? classifyCount(docksFree, partySize) : 'none'} size="sm" />
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/** One-tap destinations: saved places (Home, Work, starred), then recent ones. Stored on this device. */
function QuickDestinations() {
  const { systemId, saved, recent } = useAppStore(useShallow((s) => ({ systemId: s.systemId, saved: s.savedPlaces, recent: s.recentPlaces })))
  const { t } = useI18n()
  const chips: Array<{ key: string; icon: 'home' | 'work' | 'star' | 'clock'; label: string; place: Place }> = []
  for (const s of saved.filter((p) => p.systemId === systemId)) chips.push({ key: `s:${s.id}`, icon: s.icon, label: s.icon === 'home' ? t.home : s.icon === 'work' ? t.work : s.label, place: s.place })
  for (const [i, r] of recent.entries()) {
    if (chips.some((c) => c.place.name === r.name)) continue
    chips.push({ key: `r:${i}`, icon: 'clock', label: r.name, place: r })
  }
  if (chips.length === 0) return null
  return (
    <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 pt-1" aria-label={t.quickDestinations}>
      {chips.slice(0, 8).map((c) => (
        <li key={c.key} className="shrink-0">
        <button
          type="button"
          className="flex min-h-10 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-sm font-medium dark:bg-slate-800"
          onClick={() => {
            useAppStore.getState().pushRecent(c.place)
            useRideStore.getState().setDestination(c.place)
          }}
        >
          <Icon name={c.icon} size={16} className="shrink-0" />
          <span className="truncate">{c.label}</span>
        </button>
        </li>
      ))}
    </ul>
  )
}

function RouteError({ error }: { error: { kind: 'busy' | 'unroutable' | 'other'; message: string } }) {
  const [shownAt] = useState(() => Date.now())
  const now = useNow(500)
  const { t } = useI18n()
  const message = error.kind === 'busy' ? t.errorBusy : error.kind === 'unroutable' ? t.errorUnroutable : error.message
  const wait = error.kind === 'busy' ? Math.max(0, Math.ceil((shownAt + RIDE.busyRetrySeconds * 1000 - now) / 1000)) : 0
  return (
    <div role="alert" className={`space-y-2 rounded-xl p-3 ${error.kind === 'busy' ? 'bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100' : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200'}`}>
      {error.kind === 'busy' && <p className="font-semibold">{t.routeServerBusy}</p>}
      <p className="text-sm">{message}</p>
      <button
        type="button"
        disabled={wait > 0}
        className="min-h-11 rounded-lg bg-white px-3 text-sm font-semibold ring-1 ring-current disabled:opacity-60 dark:bg-slate-900"
        onClick={() => useRideStore.setState({ status: 'idle' })}
      >
        {wait > 0 ? t.tryAgainIn(wait) : t.tryAgain}
      </button>
    </div>
  )
}

function ShareButton({ systemId, startId, destination, routeIndex }: { systemId: string; startId: string; destination: Place; routeIndex: number }) {
  const [copied, setCopied] = useState(false)
  const { t } = useI18n()
  const share = async () => {
    const url = buildRideShareUrl(window.location.origin, {
      systemId,
      startId,
      to: { coord: destination.coord, name: destination.name },
      toStationId: destination.stationId ?? null,
      routeIndex,
    })
    const text = t.shareTitle(destination.name)
    try {
      if (typeof navigator.share === 'function') return await navigator.share({ title: text, url })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      window.prompt(t.copyLink, url)
    }
  }
  return (
    <button type="button" className="flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => void share()} aria-live="polite">
      <Icon name="share" size={18} /> {copied ? t.copied : t.share}
    </button>
  )
}

/**
 * The exact route as one GPX file for apps that follow a track turn by turn (Komoot, OsmAnd): no 3-stop
 * limit and no detours, since the app follows our line instead of choosing its own. Shared through the
 * phone's share sheet when the browser allows .gpx files there, else downloaded.
 */
function ExactRouteFile({ plan }: { plan: RidePlan }) {
  const { route, destination } = useRideStore(useShallow((s) => ({ route: s.route, destination: s.destination })))
  const [msg, setMsg] = useState<string | null>(null)
  const { t } = useI18n()
  const { start, chosen, rideParts, walkLink } = plan
  if (!route || !start || chosen.length === 0) return null
  const save = async () => {
    setMsg(null)
    const name = t.gpxName(destination?.name ?? chosen.at(-1)!.station.name)
    const gpx = rideGpx({
      name,
      route: route.geometry,
      start: { name: start.name, coord: start.coord },
      stops: chosen.map((s) => ({ name: s.station.name, coord: s.station.coord, along: s.along })),
      destination: destination ? { name: destination.name, coord: destination.coord } : null,
      timeIso: new Date().toISOString(),
    })
    const fileName = gpxFileName(destination?.name ?? null)
    const file = new File([gpx], fileName, { type: 'application/gpx+xml' })
    // The ride starts with this file instead of the Google Maps parts.
    const ride = useRideStore.getState()
    rideParts.forEach((l, i) => ride.markPartOpened(i, i === 0 && l.fromDock, !plan.walkToDock))
    if (!walkLink) ride.finishPlan()
    try {
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name })
        return
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setMsg(t.gpxSaved(fileName))
  }
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
      <p className="text-sm font-medium">{t.preferKomoot}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t.komootIntro}</p>
      <button type="button" onClick={() => void save()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold ring-1 ring-slate-300 dark:bg-slate-950 dark:ring-slate-600">
        <Icon name="download" size={18} /> {t.exactRouteButton}
      </button>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer py-1">{t.howToOpen}</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            <strong>Komoot</strong>: <Emphasized parts={t.komootSteps} />
          </li>
          <li>
            <strong>OsmAnd</strong>{t.osmandFree}: <Emphasized parts={t.osmandSteps} />
          </li>
          {walkLink && <li>{t.gpxEndsAtDock}</li>}
        </ul>
      </details>
      {msg && (
        <p role="status" className="text-xs text-slate-600 dark:text-slate-300">
          {msg}
        </p>
      )}
    </div>
  )
}

/** Whole trip at a glance (walk → ride → walk), plus walking all the way for comparison. */
function TripSummary({ plan, units }: { plan: RidePlan; units: 'imperial' | 'metric' }) {
  const { totalSeconds, walkToDock, rideSeconds: rideS, walkFromDock, walkAll } = plan
  const { t, lang } = useI18n()
  if (totalSeconds === null || rideS === null) return null
  const comparable = walkAll && walkAll.seconds <= totalSeconds + RIDE.walkComparableSeconds
  const leg = (icon: 'walk' | 'bike', s: number, kind: 'toDock' | 'ride' | 'toDestination') => (
    <span className="flex items-center gap-1" aria-label={t.legAria(formatDuration(s, lang), kind)}>
      <Icon name={icon} size={16} className="shrink-0" /> {formatDuration(s, lang)}
    </span>
  )
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{t.total(formatDuration(totalSeconds, lang))}</span>
        <span className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          {walkToDock && <>{leg('walk', walkToDock.seconds, 'toDock')}<span aria-hidden>→</span></>}
          {leg('bike', rideS, 'ride')}
          {walkFromDock && <><span aria-hidden>→</span>{leg('walk', walkFromDock.seconds, 'toDestination')}</>}
        </span>
      </div>
      {walkAll && (
        <div className="flex items-center gap-2 border-t border-slate-200 pt-2 text-sm dark:border-slate-800">
          <Icon name="walk" size={18} className="shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1">
            {t.walkStraight(formatDuration(walkAll.seconds, lang), formatDistance(walkAll.meters, units, lang))}
            {comparable && <span className="block font-medium text-brand-700 dark:text-brand-300">{t.aboutAsFast}</span>}
          </span>
          <a href={walkAll.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg px-2 py-1 font-medium text-brand-700 ring-1 ring-slate-300 dark:text-brand-300 dark:ring-slate-600">
            {t.walk}
          </a>
        </div>
      )}
    </div>
  )
}

/** What the chosen route rides on (same colors as the line on the map), and its hills. One request per route. */
function RouteDetailsCard({ systemId, units }: { systemId: string | null; units: 'imperial' | 'metric' }) {
  const route = useRideStore((s) => s.route)
  const { details, pending } = useRouteDetails(systemId, route)
  const { t, lang } = useI18n()
  if (!route) return null
  if (pending) return <p className="text-xs text-slate-500" role="status">{t.loadingPathDetails}</p>
  if (!details) return <p className="text-xs text-slate-500">{t.pathDetailsUnavailable}</p>
  const { breakdown, elevation } = details
  const total = breakdown.reduce((s, b) => s + b.meters, 0) || 1
  const pct = (m: number) => Math.round((m / total) * 100)
  const ft = (m: number) => (units === 'imperial' ? `${Math.round(m * 3.28084)} ${unitWord('ft', lang)}` : `${Math.round(m)} ${unitWord('m', lang)}`)
  return (
    <section aria-label={t.pathDetails} className="space-y-2 rounded-xl ring-1 ring-slate-200 p-3 dark:ring-slate-800">
      <div className="flex h-3 w-full overflow-hidden rounded-full" aria-hidden>
        {breakdown.map((b) => (
          <span key={b.kind} style={{ width: `${(b.meters / total) * 100}%`, background: PATH_COLORS[b.kind] }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {breakdown
          .filter((b) => pct(b.meters) >= 1)
          .map((b) => (
            <li key={b.kind} className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PATH_COLORS[b.kind] }} aria-hidden />
              {t.pathShare(pct(b.meters), t.pathKind[b.kind])}
            </li>
          ))}
      </ul>
      {elevation && (
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-sm font-medium">
            ▲ {ft(elevation.gainM)} · ▼ {ft(elevation.lossM)}
          </span>
          <ElevationSparkline profile={elevation.profile} min={elevation.minM} max={elevation.maxM} label={t.elevationProfile} />
        </div>
      )}
    </section>
  )
}

function ElevationSparkline({ profile, min, max, label }: { profile: Array<[number, number]>; min: number; max: number; label: string }) {
  const w = 160
  const h = 32
  const total = profile.at(-1)![0] || 1
  const span = Math.max(max - min, 10) // flat routes stay flat-looking
  const pts = profile.map(([a, e]) => `${((a / total) * w).toFixed(1)},${(h - 2 - ((e - min) / span) * (h - 4)).toFixed(1)}`)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 min-w-0 flex-1" preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="currentColor" className="text-brand-700/15 dark:text-brand-300/20" stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-brand-700 dark:text-brand-300" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Text with every odd part emphasized (button names inside instructions). */
function Emphasized({ parts }: { parts: readonly string[] }) {
  return <>{parts.map((p, i) => (i % 2 ? <em key={i}>{p}</em> : p))}</>
}
