import { describe, expect, it } from 'vitest'
import { RIDE } from '../config'
import { MESSAGES } from '../i18n'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import { clock, endDockState, nearestBike, nearestOpenDock, passChoiceMatters, replacementDocks, rideTimer, timerAlertTimes, upcomingTimerAlerts } from './rideProgress'

describe('ride timer', () => {
  const t0 = 1_800_000_000_000
  it('counts elapsed time and what is left of the pass', () => {
    expect(rideTimer(t0, t0 + 10 * 60_000, 30)).toEqual({ elapsedS: 600, leftS: 1200, state: 'ok' })
    expect(rideTimer(t0, t0 + (30 - RIDE.timerWarnMinutes) * 60_000, 30).state).toBe('warn')
    expect(rideTimer(t0, t0 + 31 * 60_000, 30)).toMatchObject({ leftS: -60, state: 'over' })
    expect(rideTimer(t0, t0 + 90 * 60_000, null)).toEqual({ elapsedS: 5400, leftS: null, state: 'ok' })
    expect(rideTimer(t0, t0 - 5000, 30).elapsedS).toBe(0) // clock skew never goes negative
  })

  it('times its alerts: "almost up" RIDE.timerWarnMinutes before the included time ends, then "over"', () => {
    expect(timerAlertTimes(t0, 30)).toEqual({ warnAtMs: t0 + (30 - RIDE.timerWarnMinutes) * 60_000, overAtMs: t0 + 30 * 60_000 })
    // No timer yet (walking to the dock) or no known pass: no alerts.
    expect([timerAlertTimes(null, 30), timerAlertTimes(t0, null), timerAlertTimes(t0, 0)]).toEqual([null, null, null])
  })

  it('the apps schedule the alerts still ahead, in the rider’s language', () => {
    const t = MESSAGES.en
    expect(upcomingTimerAlerts(t0, 30, t0 + 60_000, t)).toEqual([
      { kind: 'warn', atMs: t0 + 25 * 60_000, title: t.notifyWarnTitle, body: t.notifyWarnBody(RIDE.timerWarnMinutes) },
      { kind: 'over', atMs: t0 + 30 * 60_000, title: t.notifyOverTitle, body: t.extraFees },
    ])
    // Already in the last minutes (an alert that is due shows in the open app instead), or past the included time.
    expect(upcomingTimerAlerts(t0, 30, t0 + 27 * 60_000, t).map((a) => a.kind)).toEqual(['over'])
    expect(upcomingTimerAlerts(t0, 30, t0 + 31 * 60_000, t)).toEqual([])
    expect(upcomingTimerAlerts(null, 30, t0, t)).toEqual([])
    expect(upcomingTimerAlerts(t0, 30, t0, MESSAGES['zh-Hans'])[0]?.title).toBe(MESSAGES['zh-Hans'].notifyWarnTitle)
  })

  it('formats m:ss', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(754)).toBe('12:34')
    expect(clock(-61)).toBe('1:01')
  })
})

describe('end dock watch', () => {
  it('classifies open docks for the party', () => {
    expect(endDockState(makeStation({ docks: 5 }), 1)).toBe('ok')
    expect(endDockState(makeStation({ docks: 1 }), 1)).toBe('low')
    expect(endDockState(makeStation({ docks: 0 }), 1)).toBe('full')
    expect(endDockState(makeStation({ docks: 1 }), 2)).toBe('full')
    expect(endDockState(makeStation({ docks: 9, isReturning: false }), 1)).toBe('full')
    expect(endDockState(undefined, 1)).toBe('full')
  })

  it('suggests the nearest docks with space near the destination', () => {
    const near = makeStation({ id: 'near', coord: destination(MADISON.capitol, 200, 90), docks: 4 })
    const far = makeStation({ id: 'far', coord: destination(MADISON.capitol, 5000, 90), docks: 9 })
    const tight = makeStation({ id: 'tight', coord: destination(MADISON.capitol, 100, 0), docks: 1 })
    const end = makeStation({ id: 'end', coord: MADISON.capitol, docks: 0 })
    const closer = makeStation({ id: 'closer', coord: destination(MADISON.capitol, 120, 180), docks: 3 })
    const out = replacementDocks([near, far, tight, end, closer], 'end', MADISON.capitol, 1)
    expect(out.map((x) => x.station.id)).toEqual(['closer', 'near'])
  })
})

describe('nearest open dock', () => {
  const O = MADISON.capitol
  it('is the closest dock where the whole party can return, however far', () => {
    const full = makeStation({ id: 'full', coord: destination(O, 100, 0), docks: 0 })
    const closed = makeStation({ id: 'closed', coord: destination(O, 150, 0), docks: 6, isReturning: false })
    const one = makeStation({ id: 'one', coord: destination(O, 200, 90), docks: 1 })
    const far = makeStation({ id: 'far', coord: destination(O, 4000, 180), docks: 9 })
    expect(nearestOpenDock([full, closed, one, far], O, 1)).toMatchObject({ station: { id: 'one' } })
    expect(nearestOpenDock([full, closed, one, far], O, 2)?.station.id).toBe('far')
    expect(nearestOpenDock([full, closed], O, 1)).toBeNull()
  })
})

describe('nearest bike', () => {
  const O = MADISON.capitol
  it('is the closest dock where the whole party can rent, however far', () => {
    const empty = makeStation({ id: 'empty', coord: destination(O, 100, 0), bikes: 0 })
    const closed = makeStation({ id: 'closed', coord: destination(O, 150, 0), bikes: 6, isRenting: false })
    const one = makeStation({ id: 'one', coord: destination(O, 200, 90), bikes: 1 })
    const far = makeStation({ id: 'far', coord: destination(O, 4000, 180), bikes: 9 })
    expect(nearestBike([empty, closed, one, far], O, 1)).toMatchObject({ station: { id: 'one' } })
    expect(nearestBike([empty, closed, one, far], O, 2)?.station.id).toBe('far')
    expect(nearestBike([empty, closed], O, 1)).toBeNull()
  })
})

describe('asking for the rider’s pass', () => {
  const pass = (id: string, includedMinutes: number | null) => ({ id, name: id, price: 0, currency: 'USD', description: '', includedMinutes, url: null })
  it('matters only when the passes include different ride times', () => {
    expect(passChoiceMatters([pass('day', 30), pass('annual', 60)])).toBe(true)
    expect(passChoiceMatters([pass('day', 30), pass('payg', null)])).toBe(true) // pay-per-minute: no timer warnings
    expect(passChoiceMatters([pass('day', 30), pass('month', 30)])).toBe(false)
    expect(passChoiceMatters([])).toBe(false)
  })
})
