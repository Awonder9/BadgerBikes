// Ride in progress (after the rider opened a Google Maps part): ride timer against the pass's included
// minutes, a watch on the end dock (alerts when it fills up, with nearby docks that have space), and a
// banner to get back to the plan from anywhere in the app.
//
// The page cannot run while Google Maps is in front: with alerts on, the server pushes them then
// (backgroundAlerts.ts; AlertsHelp says what this phone needs for that), otherwise they fire while this app is
// open — e.g. when the rider comes back for the next part. Counts refresh as soon as the app is visible again.
import { useState } from 'react'
import { RIDE } from '../../config'
import { useNow } from '../../data/hooks'
import { formatDistance } from '../../lib/format'
import { directionsFromHereUrl } from '../../ride/googleMaps'
import { clock } from '../../ride/rideProgress'
import { rideActive, useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import { useNearestOpenDock } from '../browse/useNearestOpenDock'
import { Icon } from '../primitives/Icon'
import { AlertsHelp } from './AlertsHelp'
import { useRidePlan, type RidePlan } from './useRidePlan'
import { useRideStatus } from './useRideStatus'

/** Ride-in-progress card at the top of the planner. */
export function RideStatusCard({ plan }: { plan: RidePlan }) {
  const { active, timer, endStation, dock, replacements } = useRideStatus(plan)
  const units = useAppStore((s) => s.settings.units)
  const { t, lang } = useI18n()
  const nearest = useNearestOpenDock()
  if (!active) return null
  const tone = timer?.state === 'over' ? 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100' : timer?.state === 'warn' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-brand-50 dark:bg-brand-900'
  return (
    <section aria-label={t.rideInProgress} className={`space-y-2 rounded-xl p-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon name="clock" size={20} />
        <p className="flex-1 font-semibold">
          {timer ? (
            <>
              {t.ridingFor(clock(timer.elapsedS))}
              {timer.leftS !== null && (timer.leftS > 0 ? t.leftOnPass(Math.ceil(timer.leftS / 60)) : t.overPass(Math.ceil(-timer.leftS / 60)))}
            </>
          ) : plan.start ? (
            t.walkingTo(plan.start.name)
          ) : (
            t.rideInProgress
          )}
        </p>
        <button type="button" className="min-h-11 px-2 text-sm underline" onClick={() => useRideStore.getState().endRide()}>
          {t.endRide}
        </button>
      </div>
      {!timer && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm">{t.timerStartsNote}</p>
          <button type="button" className="min-h-11 shrink-0 rounded-lg bg-brand-700 px-3 text-sm font-semibold text-white" onClick={() => useRideStore.getState().startRideTimer()}>
            {t.unlockedBike}
          </button>
        </div>
      )}
      {timer?.state === 'warn' && <p className="text-sm">{t.dockSoon}</p>}
      {timer?.state === 'over' && <p className="text-sm">{t.extraFees}</p>}
      {timer && <RedockAlongWay />}
      {endStation && dock !== 'ok' && (
        <div role="alert" className="space-y-1 rounded-lg bg-white/70 p-2 text-sm text-slate-900 dark:bg-slate-950/60 dark:text-slate-100">
          <p className="font-semibold">
            {dock === 'full' ? t.endDockFull(endStation.name) : t.endDockLow(endStation.name, endStation.status?.docks ?? 0)}
          </p>
          {replacements.length > 0 ? (
            <ul className="space-y-1">
              {replacements.map(({ station, meters }) => (
                <li key={station.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {t.replacement(station.name, station.status?.docks ?? 0, formatDistance(meters, units, lang))}
                  </span>
                  <a className="shrink-0 rounded-lg bg-brand-700 px-2 py-1 font-semibold text-white" href={directionsFromHereUrl(station.coord, 'bicycling')} target="_blank" rel="noopener noreferrer">
                    {t.rideThere}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t.noOtherDocks}</p>
          )}
        </div>
      )}
      <button type="button" className="flex min-h-11 items-center gap-1.5 text-sm font-medium underline disabled:opacity-60" disabled={nearest.finding} onClick={nearest.find}>
        <Icon name="dock" size={16} className="shrink-0" />
        {nearest.finding ? t.findingYou : t.nearestOpenDock}
      </button>
      {nearest.message && <p className="text-sm">{nearest.message}</p>}
      <AlertsHelp />
    </section>
  )
}

/**
 * "Docked along the way? Restart the timer": the rider docked at a dock the plan didn't stop at and took a bike
 * again (a new BCycle ride). Only the timer restarts — and its alerts with it, which follow the timer's start;
 * the plan, its opened links and the trip stay. Undo for a moment, since a stray tap would lose the ride time.
 */
function RedockAlongWay() {
  const [undo, setUndo] = useState<{ previous: number; until: number } | null>(null)
  const now = useNow(1000, undo !== null)
  const { t } = useI18n()
  if (undo && now < undo.until) {
    return (
      <p role="status" className="flex min-h-11 items-center gap-2 text-sm">
        <Icon name="check" size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">{t.timerRestarted}</span>
        <button
          type="button"
          className="min-h-11 shrink-0 px-2 font-semibold underline"
          onClick={() => {
            useRideStore.getState().undoRedock(undo.previous)
            setUndo(null)
          }}
        >
          {t.undo}
        </button>
      </p>
    )
  }
  return (
    <button
      type="button"
      className="flex min-h-11 items-center gap-1.5 text-left text-sm font-medium underline"
      onClick={() => {
        const previous = useRideStore.getState().redockAlongWay()
        if (previous !== null) setUndo({ previous, until: Date.now() + RIDE.redockUndoSeconds * 1000 })
      }}
    >
      <Icon name="refresh" size={16} className="shrink-0" />
      {t.redockedAlongWay}
    </button>
  )
}

/** Shown over the map when a ride is in progress and the planner is closed (placed by AppShell's banner stack). */
export function RideBanner() {
  const hidden = useAppStore((s) => s.panel === 'ride')
  const active = useRideStore(rideActive)
  // Only while it shows: its ride plan and once-a-second clock would otherwise run under the open planner too.
  return active && !hidden ? <RideBannerShown /> : null
}

function RideBannerShown() {
  const plan = useRidePlan()
  const { timer, dock, endStation } = useRideStatus(plan)
  const { t } = useI18n()
  // Without an end dock (stations still loading after a reload, or every stop unchecked) there is none to be full.
  const alert = (!!endStation && dock !== 'ok') || timer?.state === 'over'
  const next = plan.nextPart !== null && plan.rideParts.length > 1 ? t.nextShort(plan.nextPart + 1) : null
  return (
    <button
      type="button"
      onClick={() => {
        useAppStore.getState().setPanel('ride')
        if (useAppStore.getState().sheet === 'peek') useAppStore.getState().setSheet('half')
      }}
      className={`pointer-events-auto flex min-h-12 w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-white shadow-xl ${alert ? 'bg-red-700' : timer?.state === 'warn' ? 'bg-amber-700' : 'bg-brand-700'}`}
    >
      <Icon name="bike" size={20} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {dock === 'full' && endStation ? t.bannerFull(endStation.name) : `${timer || !plan.start ? t.rideInProgress : t.walkingTo(plan.start.name)}${timer ? ` · ${clock(timer.elapsedS)}` : ''}${timer?.leftS != null && timer.leftS > 0 ? t.minLeft(Math.ceil(timer.leftS / 60)) : ''}${next ? ` · ${next}` : ''}`}
      </span>
      <Icon name="chevronRight" size={20} />
    </button>
  )
}
