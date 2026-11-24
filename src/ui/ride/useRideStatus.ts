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
import { loopsBack, useRideStore, rideActive } from '../../ride/rideStore'
import { isTrip, useTripStore } from '../../ride/tripStore'
import { useAppStore } from '../../store/appStore'
import { currentMessages } from '../../i18n/useT'
import { notificationAccess } from '../notifications'
import { isNativeApp } from '../platform'
import type { RidePlan } from './useRidePlan'

export function useRideStatus(plan: RidePlan) {
  const { systemId, partySize } = useAppStore(useShallow((s) => ({ systemId: s.systemId, partySize: s.settings.partySize })))
  const { startedAt, destination, active, roundTrip } = useRideStore(useShallow((s) => ({ startedAt: s.rideStartedAtMs, destination: s.destination, active: rideActive(s), roundTrip: loopsBack(s) })))
  const { snapshot } = useStationsSnapshot(systemId, { active })
  // The clock ticks only while a ride timer runs (this hook is used by always-mounted pieces).
  const now = useNow(1000, active && startedAt !== null)
  const timer = active && startedAt ? rideTimer(startedAt, now, plan.includedMinutes) : null
  const endStation = plan.end?.station
  // A loop just started from its own (perhaps full) end dock: not watched until the feed shows the bikes taken.
  const settling = roundTrip && startedAt !== null && now - startedAt < RIDE.loopEndWatchDelayMs
  const dock = settling ? 'ok' : endDockState(endStation, partySize)
  const near = destination?.coord ?? endStation?.coord
  const replacements = active && endStation && near && snapshot && dock !== 'ok' ? replacementDocks(snapshot.stations, endStation.id, near, partySize) : []
  return { active, startedAt, timer, endStation, dock, replacements }
}

/** A position's accuracy widens the arrival circle (RIDE.arrivedMeters) by up to this much. */
const ARRIVAL_ACCURACY_ALLOWANCE = 50
/** The farthest from the destination a position can be and still count as arrived. */
const ARRIVAL_REACH_METERS = RIDE.arrivedMeters + ARRIVAL_ACCURACY_ALLOWANCE

/**
 * Arrival: when the rider's location is already available (permission granted earlier) and they are
 * within RIDE.arrivedMeters of the destination mid-ride, the ride ends and the plan stops being saved.
 * Never prompts for location by itself.
 */
export function useArrivalCheck(): void {
  const { active, destination, startsThere, startedAt, plannedS, continuing } = useRideStore(
    useShallow((s) => ({
      active: s.openedParts.length > 0,
      destination: s.destination,
      // The ride starts within arrival range of where it ends: a loop back to its start dock, or a destination right by
      // the start (the first link is opened there, which must not count as arriving).
      startsThere: !!s.destination && (loopsBack(s) || (!!s.route && haversine(s.route.from, s.destination.coord) <= ARRIVAL_REACH_METERS)),
      startedAt: s.rideStartedAtMs,
      plannedS: s.route?.duration ?? null,
      continuing: s.continuingRide,
    })),
  )
  const fix = useLocationStore((s) => s.fix)
  // Such a ride can only be arrived at after leaving (per destination).
  const away = useRef<{ from: unknown; left: boolean }>({ from: null, left: false })
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
    const meters = haversine(fix.coord, destination.coord)
    if (away.current.from !== destination) away.current = { from: destination, left: false }
    if (startsThere && !away.current.left) {
      // Seen far enough away — or, after a reload that didn't see the rider leave, ridden for a good part of the route
      // (not a timer carried over from an earlier leg, which says nothing about this one).
      const ridden = startedAt !== null && !continuing && plannedS !== null && fix.timestampMs - startedAt >= plannedS * 1000 * RIDE.awayAfterPlannedShare
      if (meters >= RIDE.awayBeforeArrivalMeters || ridden) away.current.left = true
      if (!ridden) return
    }
    if (meters <= RIDE.arrivedMeters + Math.min(fix.accuracy, ARRIVAL_ACCURACY_ALLOWANCE)) {
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
  }, [active, fix, destination, startsThere, startedAt, plannedS, continuing])
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

