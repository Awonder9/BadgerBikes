// Multi-stop trips in the planner (src/ride/tripStore.ts): "Add a stop" under the destination, the list of
// stops with the leg on screen, and "Finished leg 1?" once a leg's last link is opened (or the rider arrived).
// Each leg is planned like a one-stop ride, docks along the route included; nothing here touches the choice of docks.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RIDE } from '../../config'
import { latestSnapshot } from '../../data/hooks'
import { useI18n } from '../../i18n/useT'
import { kNearest } from '../../lib/geo'
import { rideUnderWay, useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { isTrip, useTripStore } from '../../ride/tripStore'
import type { Place } from '../../types'
import { SearchBox } from '../browse/SearchBox'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'
import { useRideLines } from './useRideLines'
import { useRidePlan } from './useRidePlan'

function useTripView() {
  const trip = useTripStore(useShallow((s) => ({ stops: s.stops, leg: s.leg, finishedLeg: s.finishedLeg })))
  const ride = useRideStore(useShallow((s) => ({ destination: s.destination, openedParts: s.openedParts, rideStartedAtMs: s.rideStartedAtMs, finished: s.finished })))
  // Mid-ride the leg on screen is in use (timer, alerts, opened links): no switching legs or editing its ends —
  // also once it is finished, until the rider says whether it is done (LegCompleteCard) or ends the ride.
  const locked = rideUnderWay(ride)
  return { ...trip, ride, locked, active: isTrip(trip) }
}

/** "Leg 2 of 3", above the planner's steps while a trip is planned. */
export function LegIndicator() {
  const { active, leg, stops } = useTripView()
  const { t } = useI18n()
  if (!active) return null
  return <p className="text-sm font-semibold text-brand-700 dark:text-brand-300">{t.legOf(leg + 1, stops.length)}</p>
}

/**
 * Where a kept bike starts the next leg: the stop's own dock, else the dock nearest the stop (only the route's
 * starting point — the rider already has a bike, so its counts don't matter). Null without live stations.
 */
function bikeDockAt(stop: Place): Place | null {
  if (stop.stationId) return stop
  const stations = latestSnapshot(useAppStore.getState().systemId)?.stations.filter((s) => s.status?.isInstalled) ?? []
  const near = kNearest(stop.coord, stations, (s) => s.coord, 1)[0]?.item
  return near ? { kind: 'station', name: near.name, coord: near.coord, stationId: near.id } : null
}

/**
 * The leg's last link was opened (or the rider arrived) and another leg follows: is this leg done, and was the bike
 * docked? Finishing removes it (and every earlier stop) from the trip; docked stops the ride timer, otherwise the
 * next leg is ridden on the same bike and the timer runs on. Until then the leg, its ride and timer stay as they are.
 */
export function LegCompleteCard() {
  const { active, leg, stops, finishedLeg } = useTripView()
  const stop = stops[leg]
  // Only while it shows: the card works out the leg's drawn line, which costs a ride plan of its own.
  if (!active || finishedLeg < leg || !stop || !stops[leg + 1]) return null
  return <LegComplete leg={leg} stop={stop} />
}

function LegComplete({ leg, stop }: { leg: number; stop: Place }) {
  const timerRunning = useRideStore((s) => s.rideStartedAtMs !== null)
  const [docked, setDocked] = useState(false)
  const { t } = useI18n()
  // The leg as the map draws it (up to its end dock), kept on the map in a muted color once the leg is done.
  const systemId = useAppStore((s) => s.systemId)
  const route = useRideStore((s) => s.route)
  const { track } = useRideLines(systemId, useRidePlan(), route)
  const finish = () => {
    const keepBike = timerRunning && !docked
    useTripStore.getState().completeLeg(!keepBike, keepBike ? bikeDockAt(stop) : null, track)
    setDocked(false)
  }
  return (
    <section aria-label={t.legDoneQuestion(leg + 1, stop.name)} className="space-y-2 rounded-xl bg-brand-50 p-3 dark:bg-brand-900">
      <p className="font-semibold">{t.legDoneQuestion(leg + 1, stop.name)}</p>
      {timerRunning && (
        <>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={docked} onChange={(e) => setDocked(e.target.checked)} />
            <span className="font-medium">{t.dockedBike}</span>
          </label>
          <p className="text-sm text-slate-600 dark:text-slate-300">{docked ? t.dockedHelp(stop.name) : t.keptBikeHelp}</p>
        </>
      )}
      <Button block icon="check" onClick={finish}>
        {t.finishLeg(leg + 1)}
      </Button>
    </section>
  )
}

/** Under "Where to?": the stops of the trip and "Add a stop". */
export function TripStops() {
  const { active, stops, leg, finishedLeg, ride, locked } = useTripView()
  const [adding, setAdding] = useState(false)
  const { t } = useI18n()
  if (!ride.destination) return null
  const add = (p: Place) => {
    useTripStore.getState().addStop(p)
    setAdding(false)
  }
  const full = stops.length >= RIDE.maxTripStops
  const adder = adding ? (
    <SearchBox key="add-stop" label={t.nextStopLabel} placeholder={t.nextStopPlaceholder} autoFocus onSelect={add} onCancel={() => setAdding(false)} />
  ) : (
    !full && (
      <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-medium text-brand-700 dark:text-brand-300" onClick={() => setAdding(true)}>
        <Icon name="plus" size={18} /> {t.addStop}
      </button>
    )
  )
  if (!active) return <div>{adder}</div>
  return (
    <section aria-label={t.tripStops} className="space-y-2">
      <div>
        <p className="text-sm font-medium text-slate-500">{t.tripStops}</p>
        <p className="text-xs text-slate-500">{t.tripHelp}</p>
      </div>
      <ol className="divide-y divide-slate-200 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
        {stops.map((s, i) => {
          const shown = i === leg
          const done = i <= finishedLeg
          const from = i === 0 ? t.legStart : stops[i - 1]!.name
          // Mid-ride, the leg on screen keeps its ends (the stop it starts from and its destination): no edit may move them.
          const keepRemove = locked && (i === leg || i === leg - 1)
          const keepMove = locked && i >= leg - 1 && i <= leg + 1
          return (
            <li key={`${i}:${s.coord.join(',')}`} className={`flex items-center gap-1 px-2 ${shown ? 'bg-brand-50 dark:bg-brand-900' : ''}`}>
              <button
                type="button"
                disabled={shown || locked}
                aria-current={shown ? 'step' : undefined}
                aria-label={shown ? undefined : t.planLeg(i + 1, s.name)}
                onClick={() => useTripStore.getState().goToLeg(i)}
                className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-1 text-left disabled:cursor-default"
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? 'bg-brand-700 text-white' : shown ? 'bg-brand-700 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100'}`}
                  aria-hidden
                >
                  {done ? <Icon name="check" size={16} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {t.legOf(i + 1, stops.length)} · {t.legRoute(from, s.name)}
                  </span>
                </span>
                {shown ? (
                  <span className="shrink-0 rounded-full bg-brand-700 px-2 py-0.5 text-xs font-semibold text-white">{t.legShown}</span>
                ) : (
                  done && <span className="shrink-0 text-xs text-slate-500">{t.legDone}</span>
                )}
              </button>
              {i > 0 && <IconButton icon="chevronUp" label={t.moveStopUp(s.name)} variant="ghost" disabled={keepMove} onClick={() => useTripStore.getState().moveStopUp(i)} />}
              <IconButton icon="close" label={t.removeStop(s.name)} variant="ghost" disabled={keepRemove} onClick={() => useTripStore.getState().removeStop(i)} />
            </li>
          )
        })}
      </ol>
      {locked && <p className="text-xs text-slate-500">{t.stopsLockedMidRide}</p>}
      {adder}
    </section>
  )
}
