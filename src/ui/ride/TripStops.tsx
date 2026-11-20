// Multi-stop trips in the planner (src/ride/tripStore.ts): "Add a stop" under the destination, the list of
// stops with the leg on screen, and "Next leg" once a leg is finished. Each leg is planned like a one-stop
// ride, docks along the route included; nothing here touches the choice of docks.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RIDE } from '../../config'
import { useI18n } from '../../i18n/useT'
import { rideUnderWay, useRideStore } from '../../ride/rideStore'
import { isTrip, useTripStore } from '../../ride/tripStore'
import type { Place } from '../../types'
import { SearchBox } from '../browse/SearchBox'
import { Button, IconButton } from '../primitives/Button'
import { Icon } from '../primitives/Icon'

function useTripView() {
  const trip = useTripStore(useShallow((s) => ({ stops: s.stops, leg: s.leg, finishedLeg: s.finishedLeg })))
  const ride = useRideStore(useShallow((s) => ({ destination: s.destination, openedParts: s.openedParts, rideStartedAtMs: s.rideStartedAtMs, finished: s.finished })))
  // Mid-ride the leg on screen is in use (timer, alerts, opened links): no switching legs or editing its ends.
  const locked = rideUnderWay(ride) && !ride.finished
  return { ...trip, ride, locked, active: isTrip(trip) }
}

/** "Leg 2 of 3", above the planner's steps while a trip is planned. */
export function LegIndicator() {
  const { active, leg, stops } = useTripView()
  const { t } = useI18n()
  if (!active) return null
  return <p className="text-sm font-semibold text-brand-700 dark:text-brand-300">{t.legOf(leg + 1, stops.length)}</p>
}

/** The finished leg's next one, at the top of the planner. */
export function NextLegCard() {
  const { active, leg, stops, ride } = useTripView()
  const { t } = useI18n()
  const next = stops[leg + 1]
  if (!active || !ride.finished || !next) return null
  return (
    <div className="space-y-2 rounded-xl bg-brand-50 p-3 dark:bg-brand-900">
      <p className="text-sm">{t.nextLegHelp}</p>
      <Button block icon="bike" onClick={() => useTripStore.getState().goToLeg(leg + 1)}>
        {t.nextLeg(next.name)}
      </Button>
    </div>
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
