// Ride in progress (after the rider opened a Google Maps part): ride timer against the pass's included
// minutes, a watch on the end dock (alerts when it fills up, with nearby docks that have space), and a
// banner to get back to the plan from anywhere in the app.
//
// The page cannot run while Google Maps is in front, so alerts fire while this app is open — e.g. when
// the rider comes back for the next part. Counts refresh as soon as the app is visible again.
import { useState } from 'react'
import { formatDistance } from '../../lib/format'
import { directionsFromHereUrl } from '../../ride/googleMaps'
import { clock } from '../../ride/rideProgress'
import { useRideStore } from '../../ride/rideStore'
import { useAppStore } from '../../store/appStore'
import { Icon } from '../primitives/Icon'
import { useRidePlan, type RidePlan } from './useRidePlan'
import { useRideStatus } from './useRideStatus'

/** Ride-in-progress card at the top of the planner. */
export function RideStatusCard({ plan }: { plan: RidePlan }) {
  const { active, timer, endStation, dock, replacements } = useRideStatus(plan)
  const units = useAppStore((s) => s.settings.units)
  const [perm, setPerm] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
  if (!active) return null
  const tone = timer?.state === 'over' ? 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100' : timer?.state === 'warn' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-brand-50 dark:bg-brand-900'
  return (
    <section aria-label="Ride in progress" className={`space-y-2 rounded-xl p-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon name="clock" size={20} />
        <p className="flex-1 font-semibold">
          {timer ? (
            <>
              Riding {clock(timer.elapsedS)}
              {timer.leftS !== null && (timer.leftS > 0 ? ` · ${Math.ceil(timer.leftS / 60)} min left on your pass` : ` · ${Math.ceil(-timer.leftS / 60)} min over your pass`)}
            </>
          ) : (
            'Ride in progress'
          )}
        </p>
        <button type="button" className="min-h-11 px-2 text-sm underline" onClick={() => useRideStore.getState().endRide()}>
          End ride
        </button>
      </div>
      {timer?.state === 'warn' && <p className="text-sm">Dock soon to stay within your pass. Re-docking starts a new ride.</p>}
      {timer?.state === 'over' && <p className="text-sm">Extra fees may apply until you dock.</p>}
      {endStation && dock !== 'ok' && (
        <div role="alert" className="space-y-1 rounded-lg bg-white/70 p-2 text-sm text-slate-900 dark:bg-slate-950/60 dark:text-slate-100">
          <p className="font-semibold">
            {dock === 'full' ? `${endStation.name} is full right now.` : `${endStation.name} has only ${endStation.status?.docks ?? 0} open ${endStation.status?.docks === 1 ? 'dock' : 'docks'}.`}
          </p>
          {replacements.length > 0 ? (
            <ul className="space-y-1">
              {replacements.map(({ station, meters }) => (
                <li key={station.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {station.name} · {station.status?.docks ?? 0} open · {formatDistance(meters, units)} from your destination
                  </span>
                  <a className="shrink-0 rounded-lg bg-brand-700 px-2 py-1 font-semibold text-white" href={directionsFromHereUrl(station.coord, 'bicycling')} target="_blank" rel="noopener noreferrer">
                    Ride there
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>No other docks with space close to your destination right now.</p>
          )}
        </div>
      )}
      {perm === 'default' && (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => {
            void Notification.requestPermission().then((p) => setPerm(p))
          }}
        >
          Turn on alerts (time running low, end dock full)
        </button>
      )}
      <p className="text-xs opacity-80">Alerts and counts update while this app is open — check back between parts.</p>
    </section>
  )
}

/** Shown over the map when a ride is in progress and the planner is closed. */
export function RideBanner() {
  const panel = useAppStore((s) => s.panel)
  const plan = useRidePlan()
  const { active, timer, dock, endStation } = useRideStatus(plan)
  if (!active || panel === 'ride') return null
  const alert = dock !== 'ok' || timer?.state === 'over'
  const next = plan.nextPart !== null && plan.rideParts.length > 1 ? `Next: Part ${plan.nextPart + 1}` : null
  return (
    <button
      type="button"
      onClick={() => {
        useAppStore.getState().setPanel('ride')
        if (useAppStore.getState().sheet === 'peek') useAppStore.getState().setSheet('half')
      }}
      className={`absolute inset-x-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] z-30 flex min-h-12 items-center gap-2 rounded-2xl px-3 py-2 text-left text-white shadow-xl ${alert ? 'bg-red-700' : timer?.state === 'warn' ? 'bg-amber-700' : 'bg-brand-700'}`}
    >
      <Icon name="bike" size={20} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {dock === 'full' && endStation ? `${endStation.name} is full — tap for nearby docks` : `Ride in progress${timer ? ` · ${clock(timer.elapsedS)}` : ''}${timer?.leftS != null && timer.leftS > 0 ? ` · ${Math.ceil(timer.leftS / 60)} min left` : ''}${next ? ` · ${next}` : ''}`}
      </span>
      <Icon name="chevronRight" size={20} />
    </button>
  )
}
