// Live status of a ride in progress (timer, end dock, replacements) and the one-shot alerts for it.
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RIDE } from '../../config'
import { useNow, useStationsSnapshot } from '../../data/hooks'
import { haversine } from '../../lib/geo'
import { locationAllowed } from '../../location/geoSource'
import { useLocationStore } from '../../location/locationStore'
import { showAlertNow } from '../../native/notifications'
import { ALERT_TAGS, endDockState, replacementDocks, rideTimer, type AlertKind } from '../../ride/rideProgress'
import { useRideStore, rideActive } from '../../ride/rideStore'
import { isTrip, useTripStore } from '../../ride/tripStore'
import { useAppStore } from '../../store/appStore'
import { currentMessages } from '../../i18n/useT'
import { notificationAccess } from '../notifications'
import { isNativeApp } from '../platform'
import type { RidePlan } from './useRidePlan'

export function useRideStatus(plan: RidePlan) {
  const { systemId, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize })))
  const { startedAt, destination, active } = useRideStore(useShallow((s) => ({ startedAt: s.rideStartedAtMs, destination: s.destination, active: rideActive(s) })))
  const { snapshot } = useStationsSnapshot(systemId, { active })
  // The clock ticks only while a ride timer runs (this hook is used by always-mounted pieces).
  const now = useNow(1000, active && startedAt !== null)
  const timer = active && startedAt ? rideTimer(startedAt, now, plan.includedMinutes) : null
  const endStation = plan.end?.station
  const dock = endDockState(endStation, partySize)
  const near = destination?.coord ?? endStation?.coord
  const replacements = active && endStation && near && snapshot && dock !== 'ok' ? replacementDocks(snapshot.stations, endStation.id, near, partySize) : []
  return { active, startedAt, timer, endStation, dock, replacements }
}

/**
 * Arrival: when the rider's location is already available (permission granted earlier) and they are
 * within RIDE.arrivedMeters of the destination mid-ride, the ride ends and the plan stops being saved.
 * Never prompts for location by itself.
 */
export function useArrivalCheck(): void {
  const { active, destination } = useRideStore(useShallow((s) => ({ active: s.openedParts.length > 0, destination: s.destination })))
  const fix = useLocationStore((s) => s.fix)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void locationAllowed().then((allowed) => {
      if (!cancelled && allowed) useLocationStore.getState().requestLocation()
    })
    return () => {
      cancelled = true
    }
  }, [active])
  useEffect(() => {
    // A coarse fix (cell towers, a jump) could be anywhere near: only an accurate one may end the ride.
    if (!active || !fix || !destination || fix.accuracy > RIDE.arrivedMaxAccuracyMeters) return
    if (haversine(fix.coord, destination.coord) <= RIDE.arrivedMeters + Math.min(fix.accuracy, 50)) {
      // A trip's stop with a leg after it: the planner asks whether the leg is done and the bike docked (the rider
      // may ride on with it), so the ride and its timer stay as they are until then.
      const trip = useTripStore.getState()
      if (isTrip(trip) && trip.leg < trip.stops.length - 1) {
        if (trip.finishedLeg < trip.leg) useRideStore.getState().finishPlan()
        return
      }
      useRideStore.getState().finishPlan()
      useRideStore.getState().endRide()
    }
  }, [active, fix, destination])
}

/**
 * Fires a vibration + system notification (when allowed) once per condition while a ride is active and the
 * app is open. In the background the Worker sends the same alerts (backgroundAlerts.ts) with the same tags,
 * so one replaces the other instead of both showing; in the iOS/Android apps the timer's are scheduled on the
 * phone instead (nativeRideAlerts.ts).
 */
export function useRideAlerts(plan: RidePlan): void {
  const { active, startedAt, timer, endStation, dock } = useRideStatus(plan)
  const fired = useRef(new Set<string>())
  useEffect(() => {
    if (!active) {
      fired.current.clear()
      return
    }
    const t = currentMessages()
    const alerts: Array<[key: string, kind: AlertKind, title: string, body: string]> = []
    // Keyed by the timer's start: re-docking starts a new BCycle ride (a new timer), which warns again.
    if (timer?.state === 'warn') alerts.push([`warn:${startedAt}`, 'warn', t.notifyWarnTitle, t.notifyWarnBody(Math.ceil((timer.leftS ?? 0) / 60))])
    if (timer?.state === 'over') alerts.push([`over:${startedAt}`, 'over', t.notifyOverTitle, t.extraFees])
    if (endStation && dock === 'full') alerts.push([`full:${endStation.id}`, 'full', t.notifyFullTitle, t.notifyFullBody(endStation.name)])
    else if (endStation && dock === 'low') alerts.push([`low:${endStation.id}`, 'low', t.notifyLowTitle, t.notifyLowBody(endStation.name, endStation.status?.docks ?? 0)])
    for (const [key, kind, title, body] of alerts) {
      if (fired.current.has(key)) continue
      fired.current.add(key)
      notify(kind, title, body)
    }
  }, [active, startedAt, timer?.state, timer?.leftS, endStation, dock])
}

function notify(kind: AlertKind, title: string, body: string): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200])
  if (isNativeApp()) {
    // The timer's alerts are already scheduled on the phone and show themselves, in front of the app too: shown
    // again here they would alert twice. The end dock's can only come from here.
    if ((kind === 'full' || kind === 'low') && notificationAccess() === 'granted') showAlertNow(kind, title, body, currentMessages().notifyChannel)
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const options: NotificationOptions = { body, icon: '/icons/icon-192.png', tag: ALERT_TAGS[kind] }
  const page = () => {
    try {
      const n = new Notification(title, options)
      n.addEventListener('click', () => window.focus())
    } catch {
      /* not allowed here either; the in-app card still shows it */
    }
  }
  // Through the service worker first: Android Chrome (and installed iOS web apps) refuse `new Notification()`.
  // Tapping it brings the app back (public/sw-notifications.js).
  if (!('serviceWorker' in navigator)) return page()
  navigator.serviceWorker
    .getRegistration()
    .then((reg) => (reg ? reg.showNotification(title, options) : page()))
    .catch(page)
}

