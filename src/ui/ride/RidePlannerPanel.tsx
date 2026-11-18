// Ride planner: start dock → destination → route option → docks along the route → open in Google Maps,
// plus the ride-in-progress card once the rider has opened a part.
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BIKE_ROUTING, RIDE } from '../../config'
import { useNow, useStationsSnapshot } from '../../data/hooks'
import { bikeMix, formatDistance, formatDuration } from '../../lib/format'
import { bboxOf, kNearest } from '../../lib/geo'
import { canRent, classifyCount, classifyStation } from '../../lib/stationState'
import { buildRideShareUrl } from '../../lib/urlParams'
import { gpxFileName, rideGpx } from '../../ride/gpx'
import { waitForFix } from '../../location/locationStore'
import { useMapApiGetter } from '../../map/mapApiContext'
import { chooseRoute, docksAlong, loadRideRoute, useRideStore } from '../../ride/rideStore'
import { MAX_STRETCH_MINUTES, rideSeconds } from '../../ride/stationsAlongRoute'
import { sameRoute } from '../../routing/sameRoute'
import { useAppStore } from '../../store/appStore'
import type { Place, Station } from '../../types'
import { SearchBox } from '../browse/SearchBox'
import { AvailabilityPill } from '../primitives/Availability'
import { IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { RideStatusCard } from './RideProgress'
import { useRidePlan, type RidePlan } from './useRidePlan'

export function RidePlannerPanel() {
  const { systemId, units, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, units: s.settings.units, partySize: s.settings.partySize })))
  const ride = useRideStore()
  const { snapshot } = useStationsSnapshot(systemId, { active: true })
  const plan = useRidePlan()
  const { start, along, end, rideParts, walkLink, nextPart, segments, electric, includedMinutes } = plan
  const getMap = useMapApiGetter()

  // Frame the whole route once it arrives.
  useEffect(() => {
    const b = ride.route ? bboxOf(ride.route.geometry) : null
    if (b) getMap()?.fitBounds(b, { maxZoom: 16 })
  }, [ride.route, getMap])

  // Route whenever both ends are known.
  useEffect(() => {
    if (systemId && snapshot && ride.startId && ride.destination && ride.status === 'idle') void loadRideRoute(systemId, snapshot, units, partySize)
  }, [systemId, snapshot, ride.startId, ride.destination, ride.status, units, partySize])

  const dest = ride.destination
  const dockCounts = useMemo(
    () => (snapshot && start && dest ? ride.routes.map((r) => docksAlong(r, snapshot, start.id, dest, partySize).filter((s) => s.reason === 'onRoute' && (s.station.status?.docks ?? 0) > 0).length) : []),
    [ride.routes, snapshot, start, dest, partySize],
  )
  const order = along.map((s) => s.station.id)
  const riding = ride.openedParts.length > 0

  return (
    <section aria-label="Plan a ride" className="space-y-3 p-4">
      <header className="flex items-center gap-1">
        <IconButton icon="back" label="Back" variant="ghost" onClick={() => useAppStore.getState().setPanel('browse')} />
        <h2 className="flex-1 text-xl font-semibold">{riding ? 'Your ride' : 'Plan a ride'}</h2>
        {systemId && start && dest && ride.status === 'ready' && <ShareButton systemId={systemId} startId={start.id} destination={dest} routeIndex={ride.routeIndex} />}
        {(ride.startId || ride.destination) && (
          <button type="button" className="min-h-11 px-2 text-sm text-slate-500 underline" onClick={ride.reset}>
            Clear
          </button>
        )}
      </header>

      <RideStatusCard plan={plan} />

      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-500">1. Start dock</p>
        {start ? <StartDock station={start} partySize={partySize} /> : <StartDockPicker partySize={partySize} />}
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-500">2. Where to?</p>
        <SearchBox key={`dest:${dest?.name ?? ''}`} label="Destination" placeholder="A place or a dock" initialValue={dest?.name ?? ''} onSelect={(p) => ride.setDestination(p)} />
        {!dest && <QuickDestinations />}
      </div>

      {ride.status === 'routing' && (
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300" role="status">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden />
          Finding the best route and docks along it…
        </p>
      )}
      {ride.status === 'error' && ride.error && <RouteError error={ride.error} />}

      {ride.status === 'ready' && ride.route && start && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-500">3. Choose a route</p>
            <div role="radiogroup" aria-label="Route options" className="grid grid-cols-3 gap-2">
              {ride.routes.map((r, i) => {
                const label = BIKE_ROUTING.options[i]?.label ?? `Option ${i + 1}`
                const dup = ride.routes.findIndex((o, j) => j < i && sameRoute(o.geometry, r.geometry, BIKE_ROUTING.duplicateRouteMeters))
                const sameAs = dup >= 0 ? (BIKE_ROUTING.options[dup]?.label ?? null) : null
                return (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={i === ride.routeIndex}
                    aria-label={`${label}: about ${formatDuration(r.duration)}, ${formatDistance(r.distance, units)}${sameAs ? `, same route as ${sameAs}` : ''}, ${dockCounts[i] ?? 0} docks on route`}
                    onClick={() => snapshot && chooseRoute(i, snapshot, partySize)}
                    className={`flex min-h-20 flex-col items-center justify-center rounded-xl px-1 py-2 text-center ring-1 ${i === ride.routeIndex ? 'bg-brand-50 ring-2 ring-brand-700 dark:bg-brand-900' : 'ring-slate-300 dark:ring-slate-600'}`}
                  >
                    <span className="whitespace-nowrap text-[13px] font-semibold leading-tight">{label}</span>
                    <span className="mt-1 text-lg font-bold leading-tight">~{formatDuration(r.duration)}</span>
                    <span className={`text-xs ${i === ride.routeIndex ? 'text-slate-600 dark:text-slate-300' : 'text-slate-500'}`}>{sameAs ? `Same as ${sameAs}` : formatDistance(r.distance, units)}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <p className="text-sm font-medium text-slate-500">4. Docks on this route — uncheck any you don't want to stop at</p>
          {along.length === 0 ? (
            <p className="text-sm text-amber-800 dark:text-amber-300">No BCycle docks on this route. Try another route option or a destination closer to a station.</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
              {along.map((s) => {
                const checked = ride.stopIds.includes(s.station.id)
                const isEnd = end?.station.id === s.station.id
                const docks = s.station.status?.docks ?? 0
                const accepts = !!s.station.status?.isReturning && docks > 0
                const seg = segments.find((g) => g.toId === s.station.id)
                return (
                  <li key={s.station.id}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
                      <input type="checkbox" className="h-5 w-5 shrink-0" checked={checked} onChange={() => ride.toggleStop(s.station.id, order)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{s.station.name}</span>
                        <span className="block text-sm text-slate-500">
                          ~{formatDuration(rideSeconds(s.along, electric))} into the ride · {formatDistance(s.offset, units)} off route
                          {isEnd && <span className="ml-1 font-semibold text-brand-700 dark:text-brand-300">· Ride ends here</span>}
                        </span>
                        {s.reason === 'redock' && <span className="block text-sm text-slate-600 dark:text-slate-300">Off route — added so you can re-dock within {MAX_STRETCH_MINUTES} min</span>}
                        {s.reason === 'nearDestination' && <span className="block text-sm text-slate-600 dark:text-slate-300">Off route — closest dock to your destination</span>}
                        {checked && seg?.overIncluded && <span className="block text-sm text-amber-800 dark:text-amber-300">This stretch is longer than your {includedMinutes}-min pass — add a stop before it to re-dock.</span>}
                        {checked && !accepts && <span className="block text-sm text-red-700 dark:text-red-400">No open docks right now.</span>}
                      </span>
                      <AvailabilityPill kind="docks" count={docks} state={accepts ? classifyCount(docks, partySize) : 'none'} size="sm" />
                    </label>
                  </li>
                )
              })}
            </ul>
          )}

          {rideParts.length > 0 && start && end && ride.route && <ExactRouteFile plan={plan} />}

          {rideParts.length > 0 ? (
            <div className="sticky bottom-0 -mx-4 space-y-1 border-t border-slate-200 bg-white px-4 pb-2 pt-2 dark:border-slate-800 dark:bg-slate-950">
              {rideParts.length > 1 && (
                <p className="text-xs leading-snug text-slate-500">
                  {nextPart === null
                    ? 'All parts opened. Tap a part to open it again.'
                    : riding
                      ? `Next: Part ${nextPart + 1}${rideParts[nextPart]?.endLabel ? ` → ${rideParts[nextPart]?.endLabel}` : ''}`
                      : 'Google Maps allows 3 stops per link — open the next part when you arrive.'}
                </p>
              )}
              <div className="flex gap-1.5">
                {rideParts.map((l, i) => {
                  const done = ride.openedParts.includes(i)
                  const isNext = i === nextPart
                  return (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${rideParts.length === 1 ? 'Open in Google Maps' : `Part ${i + 1}`}${l.endLabel ? `, to ${l.endLabel}` : ''}${done ? ', opened' : ''}`}
                      onClick={() => {
                        ride.markPartOpened(i, l.fromDock)
                        // The last link of the trip: stop saving the plan on the device.
                        if (!walkLink && i === rideParts.length - 1) ride.finishPlan()
                      }}
                      className={`flex min-h-12 min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-xl px-1.5 font-semibold ${
                        done && !isNext ? 'bg-white text-brand-800 ring-1 ring-brand-700 dark:bg-slate-900 dark:text-brand-200' : 'bg-brand-700 text-white'
                      } ${isNext && riding ? 'ring-4 ring-brand-300 dark:ring-brand-600' : ''}`}
                    >
                      <Icon name={done ? 'check' : 'external'} size={16} className="shrink-0" /> {rideParts.length === 1 ? 'Open in Google Maps' : `Part ${i + 1}`}
                    </a>
                  )
                })}
                {walkLink && (
                  <a href={walkLink.url} target="_blank" rel="noopener noreferrer" onClick={() => ride.finishPlan()} aria-label="Then walk to your destination in Google Maps" className="flex min-h-12 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-xl bg-white px-2.5 text-sm font-medium ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-600">
                    <Icon name="walk" size={18} /> Walk
                  </a>
                )}
              </div>
            </div>
          ) : (
            along.length > 0 && <p className="text-sm text-slate-500">Keep at least one dock checked to end your ride.</p>
          )}
        </>
      )}
    </section>
  )
}

function StartDock({ station, partySize }: { station: Station; partySize: number }) {
  const s = station.status
  const mix = s && s.ebikes !== null && s.classic !== null && s.bikes > 0 ? bikeMix(s.ebikes, s.classic) : null
  return (
    <>
      <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
        <Icon name="bike" size={20} className="shrink-0 text-brand-700" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium leading-snug">{station.name}</span>
          {mix && <span className="block text-sm text-slate-500">{mix}</span>}
        </span>
        <AvailabilityPill kind="bikes" count={s?.bikes ?? 0} state={classifyStation(station, partySize).bikeState} size="sm" />
        <button type="button" className="min-h-11 px-2 text-sm text-brand-700 dark:text-brand-300" onClick={() => useRideStore.getState().setStart(null)}>
          Change
        </button>
      </div>
      {!canRent(station, partySize) && <p className="text-sm text-amber-800 dark:text-amber-300">This dock has no bikes available right now.</p>}
    </>
  )
}

function StartDockPicker({ partySize }: { partySize: number }) {
  const systemId = useAppStore((s) => s.systemId)
  const { snapshot } = useStationsSnapshot(systemId)
  const [locating, setLocating] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const nearestFrom = (coord: [number, number]) => (snapshot ? kNearest(coord, snapshot.stations.filter((s) => canRent(s, partySize)), (s) => s.coord, 1)[0] : undefined)
  const choose = (p: Place) => {
    if (p.stationId) return useRideStore.getState().setStart(p.stationId)
    // A place: start at the nearest dock with bikes.
    const near = nearestFrom(p.coord)
    if (near) useRideStore.getState().setStart(near.item.id)
  }
  const nearestToMe = async () => {
    setMsg(null)
    setLocating(true)
    const here = await waitForFix()
    setLocating(false)
    if (!here) return setMsg('Your location isn’t available. Search for a dock or tap one on the map instead.')
    const near = nearestFrom(here)
    if (near) useRideStore.getState().setStart(near.item.id)
    else setMsg('No dock with bikes found near you.')
  }
  return (
    <>
      <button
        type="button"
        disabled={locating || !snapshot}
        onClick={() => void nearestToMe()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-3 font-semibold text-white disabled:opacity-60"
      >
        {locating ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden /> : <Icon name="locate" size={20} />}
        {locating ? 'Finding you…' : 'Nearest dock with bikes'}
      </button>
      {msg && <p className="text-sm text-amber-800 dark:text-amber-300">{msg}</p>}
      <SearchBox key="start" label="Start dock" placeholder="Or search a dock (or tap one on the map)" onSelect={choose} />
    </>
  )
}

/** One-tap destinations: saved places (Home, Work, starred), then recent ones. Stored on this device. */
function QuickDestinations() {
  const { systemId, saved, recent } = useAppStore(useShallow((s) => ({ systemId: s.systemId, saved: s.savedPlaces, recent: s.recentPlaces })))
  const chips: Array<{ key: string; icon: 'home' | 'work' | 'star' | 'clock'; label: string; place: Place }> = []
  for (const s of saved.filter((p) => p.systemId === systemId)) chips.push({ key: `s:${s.id}`, icon: s.icon, label: s.label, place: s.place })
  for (const [i, r] of recent.entries()) {
    if (chips.some((c) => c.place.name === r.name)) continue
    chips.push({ key: `r:${i}`, icon: 'clock', label: r.name, place: r })
  }
  if (chips.length === 0) return null
  return (
    <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 pt-1" aria-label="Quick destinations">
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
  const wait = error.kind === 'busy' ? Math.max(0, Math.ceil((shownAt + RIDE.busyRetrySeconds * 1000 - now) / 1000)) : 0
  return (
    <div role="alert" className={`space-y-2 rounded-xl p-3 ${error.kind === 'busy' ? 'bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100' : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200'}`}>
      {error.kind === 'busy' && <p className="font-semibold">Route server busy</p>}
      <p className="text-sm">{error.message}</p>
      <button
        type="button"
        disabled={wait > 0}
        className="min-h-11 rounded-lg bg-white px-3 text-sm font-semibold ring-1 ring-current disabled:opacity-60 dark:bg-slate-900"
        onClick={() => useRideStore.setState({ status: 'idle' })}
      >
        {wait > 0 ? `Try again in ${wait}s` : 'Try again'}
      </button>
    </div>
  )
}

function ShareButton({ systemId, startId, destination, routeIndex }: { systemId: string; startId: string; destination: Place; routeIndex: number }) {
  const [copied, setCopied] = useState(false)
  const share = async () => {
    const url = buildRideShareUrl(window.location.origin, {
      systemId,
      startId,
      to: { coord: destination.coord, name: destination.name },
      toStationId: destination.stationId ?? null,
      routeIndex,
    })
    const text = `Bike-share ride to ${destination.name}`
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
      window.prompt('Copy this link:', url)
    }
  }
  return (
    <button type="button" className="flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => void share()} aria-live="polite">
      <Icon name="share" size={18} /> {copied ? 'Copied' : 'Share'}
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
  const { start, chosen, rideParts, walkLink } = plan
  if (!route || !start || chosen.length === 0) return null
  const save = async () => {
    setMsg(null)
    const name = `Bike ride to ${destination?.name ?? chosen.at(-1)!.station.name}`
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
    rideParts.forEach((l, i) => ride.markPartOpened(i, i === 0 && l.fromDock))
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
    setMsg(`Saved ${fileName}. Open it with Komoot or OsmAnd (from your Downloads or Files).`)
  }
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
      <p className="text-sm font-medium">Prefer Komoot or OsmAnd?</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">They follow this exact route as one file — no 3-stop limit, no parts, and no detours.</p>
      <button type="button" onClick={() => void save()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold ring-1 ring-slate-300 dark:bg-slate-950 dark:ring-slate-600">
        <Icon name="download" size={18} /> Exact route for Komoot / OsmAnd (.gpx)
      </button>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer py-1">How to open it</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            <strong>Komoot</strong>: share or open the file in Komoot, choose <em>Stick to original route</em>, then <em>Start navigation</em>. Your first region is free.
          </li>
          <li>
            <strong>OsmAnd</strong> (free): open the file in OsmAnd, tap the track → <em>Navigate</em> → <em>Follow track</em>, with the bicycle profile.
          </li>
          {walkLink && <li>The file ends at your last dock; use the Walk button for the rest.</li>}
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
