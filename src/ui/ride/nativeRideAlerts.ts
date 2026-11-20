// The ride timer's alerts inside the iOS/Android apps, whose web views have no Web Push: "time almost up" and
// "past your included time" are scheduled on the phone as local notifications while a ride's timer runs, so they
// arrive while Google Maps is in front without a server. They are scheduled again when the timer, the pass, the
// language or the permissions change, and cancelled when the ride ends. "End dock full" needs the server to watch
// the dock, which the apps can't reach yet (native push): it shows while the app is open (useRideAlerts).
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MESSAGES } from '../../i18n'
import { useLang } from '../../i18n/useT'
import { scheduleTimerAlerts } from '../../native/notifications'
import { upcomingTimerAlerts } from '../../ride/rideProgress'
import { useRideStore } from '../../ride/rideStore'
import { useExactAlarmAccess, useNotificationAccess } from '../notifications'
import { isNativeApp } from '../platform'
import type { RidePlan } from './useRidePlan'

/** Mounted once (AppShell's RideWatchers). Does nothing in the web app (backgroundAlerts.ts covers it there). */
export function useNativeRideAlerts(plan: RidePlan): void {
  const { active, startedAt } = useRideStore(useShallow((s) => ({ active: s.openedParts.length > 0 || s.walkToDockOpened, startedAt: s.rideStartedAtMs })))
  const allowed = useNotificationAccess() === 'granted'
  // Turned on mid-ride: the alerts are scheduled again, on time this time.
  const exactAlarms = useExactAlarmAccess()
  const lang = useLang()
  const { includedMinutes } = plan
  useEffect(() => {
    if (!isNativeApp()) return
    const t = MESSAGES[lang]
    scheduleTimerAlerts(active && allowed ? upcomingTimerAlerts(startedAt, includedMinutes, Date.now(), t) : [], t.notifyChannel, exactAlarms)
  }, [active, allowed, exactAlarms, startedAt, includedMinutes, lang])
}
