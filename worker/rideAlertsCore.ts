// Background ride alerts, pure part: which alerts are due, what they say, and when to wake up next. The
// RideAlerts Durable Object (worker/rideAlerts.ts) stores this state per device and runs it on alarms. The
// alert text comes from the app's own messages (src/i18n) and the station feed — never from the request.
import type { PushRideRequest } from '../src/api/contract'
import { PUSH } from '../src/config'
import { MESSAGES, type Lang } from '../src/i18n'
import { ALERT_TAGS, timerAlertTimes, type EndDockState } from '../src/ride/rideProgress'

export type AlertKind = 'warn' | 'over' | 'full'

export interface RideAlertState {
  endpoint: string
  p256dh: string
  auth: string
  lang: Lang
  systemId: string
  endStationId: string | null
  partySize: number
  startedAtMs: number | null
  /** Included time runs low / runs out (null without a ride timer or a known pass). */
  warnAtMs: number | null
  overAtMs: number | null
  /** Nothing is sent after this. */
  expiresAtMs: number
  sent: Record<AlertKind, boolean>
}

/**
 * The state for a (re-)registered ride. Re-registering the same ride (the app re-opened after Google Maps,
 * a re-dock of the same timer) keeps what was already sent, so nothing is repeated; a new timer or a new end
 * dock starts its alerts afresh.
 */
export function planRide(req: PushRideRequest, nowMs: number, prev: RideAlertState | null): RideAlertState {
  const startedAtMs = req.rideStartedAtMs
  const times = timerAlertTimes(startedAtMs, req.includedMinutes)
  const overAtMs = times?.overAtMs ?? null
  const warnAtMs = times?.warnAtMs ?? null
  const sameTimer = !!prev && prev.overAtMs === overAtMs && prev.startedAtMs === startedAtMs
  const sameDock = !!prev && prev.endStationId === req.endStationId
  return {
    endpoint: req.subscription.endpoint,
    p256dh: req.subscription.keys.p256dh,
    auth: req.subscription.keys.auth,
    lang: req.lang,
    systemId: req.systemId,
    endStationId: req.endStationId,
    partySize: req.partySize,
    startedAtMs,
    warnAtMs,
    overAtMs,
    expiresAtMs: (startedAtMs ?? nowMs) + PUSH.maxRideMs,
    sent: {
      warn: sameTimer && prev.sent.warn,
      over: sameTimer && prev.sent.over,
      full: sameDock && prev.sent.full,
    },
  }
}

/** Alerts to send now. Past the included time only "over" goes out (a late "almost up" would be wrong). */
export function dueAlerts(s: RideAlertState, nowMs: number, endDock: EndDockState | null): AlertKind[] {
  const due: AlertKind[] = []
  if (s.overAtMs !== null && !s.sent.over && nowMs >= s.overAtMs) due.push('over')
  else if (s.warnAtMs !== null && !s.sent.warn && nowMs >= s.warnAtMs) due.push('warn')
  if (s.endStationId && !s.sent.full && endDock === 'full') due.push('full')
  return due
}

/** Records a delivered alert ("over" makes "almost up" moot). */
export function markSent(s: RideAlertState, kind: AlertKind): void {
  s.sent[kind] = true
  if (kind === 'over') s.sent.warn = true
}

/** When to wake up next: the next timer alert or end-dock check; null when nothing is left to do. */
export function nextWakeMs(s: RideAlertState, nowMs: number): number | null {
  if (nowMs >= s.expiresAtMs) return null
  const times: number[] = []
  if (s.warnAtMs !== null && !s.sent.warn) times.push(s.warnAtMs)
  if (s.overAtMs !== null && !s.sent.over) times.push(s.overAtMs)
  if (s.endStationId && !s.sent.full) times.push(nowMs + PUSH.dockCheckMs)
  if (times.length === 0) return null
  const next = Math.min(...times)
  // Already due but not delivered (the push service failed): try again a little later.
  return Math.min(s.expiresAtMs, next <= nowMs ? nowMs + PUSH.retryMs : next)
}

/** The notification for an alert, in the rider's language. */
export function alertMessage(kind: AlertKind, s: RideAlertState, nowMs: number, stationName: string | null): { title: string; body: string; tag: string } {
  const t = MESSAGES[s.lang]
  const tag = ALERT_TAGS[kind]
  if (kind === 'warn') {
    const left = Math.max(1, Math.ceil(((s.overAtMs ?? nowMs) - nowMs) / 60_000))
    return { title: t.notifyWarnTitle, body: t.notifyWarnBody(left), tag }
  }
  if (kind === 'over') return { title: t.notifyOverTitle, body: t.extraFees, tag }
  return { title: t.notifyFullTitle, body: t.notifyFullBody(stationName ?? t.station), tag }
}
