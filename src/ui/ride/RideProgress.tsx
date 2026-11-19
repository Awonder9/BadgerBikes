// Ride in progress (after the rider opened a Google Maps part): ride timer against the pass's included
// minutes, a watch on the end dock (alerts when it fills up, with nearby docks that have space), and a
// banner to get back to the plan from anywhere in the app.
//
// The page cannot run while Google Maps is in front, so alerts fire while this app is open — e.g. when
// the rider comes back for the next part. Counts refresh as soon as the app is visible again.
import { formatDistance } from '../../lib/format'
import { directionsFromHereUrl } from '../../ride/googleMaps'
import { clock } from '../../ride/rideProgress'
import { useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useT'
import { useNearestOpenDock } from '../browse/useNearestOpenDock'
import { requestNotificationAccess, useNotificationAccess } from '../notifications'
import { isStandalone, platform } from '../platform'
import { Icon } from '../primitives/Icon'
import { useBackgroundAlerts } from './backgroundAlerts'
import { useRidePlan, type RidePlan } from './useRidePlan'
import { useRideStatus } from './useRideStatus'

/** Ride-in-progress card at the top of the planner. */
export function RideStatusCard({ plan }: { plan: RidePlan }) {
  const { active, timer, endStation, dock, replacements } = useRideStatus(plan)
  const units = useAppStore((s) => s.settings.units)
  const { t, lang } = useI18n()
  const access = useNotificationAccess()
  const background = useBackgroundAlerts((s) => s.on)
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
      {access === 'default' && (
        <button type="button" className="text-sm underline" onClick={() => void requestNotificationAccess()}>
          {t.turnOnAlerts}
        </button>
      )}
      <p className="text-xs opacity-80">{background ? t.alertsBackground : platform() === 'ios' && !isStandalone() ? t.alertsIosInstall : t.alertsNote}</p>
    </section>
  )
}

/** Shown over the map when a ride is in progress and the planner is closed (placed by AppShell's banner stack). */
export function RideBanner() {
  const panel = useAppStore((s) => s.panel)
  const plan = useRidePlan()
  const { active, timer, dock, endStation } = useRideStatus(plan)
  const { t } = useI18n()
  if (!active || panel === 'ride') return null
  const alert = dock !== 'ok' || timer?.state === 'over'
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
