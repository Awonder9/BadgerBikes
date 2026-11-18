import { describe, expect, it } from 'vitest'
import { RIDE } from '../config'
import { destination } from '../lib/geo'
import { MADISON, makeStation } from '../test/factories'
import { clock, endDockState, replacementDocks, rideTimer } from './rideProgress'

describe('ride timer', () => {
  const t0 = 1_800_000_000_000
  it('counts elapsed time and what is left of the pass', () => {
    expect(rideTimer(t0, t0 + 10 * 60_000, 30)).toEqual({ elapsedS: 600, leftS: 1200, state: 'ok' })
    expect(rideTimer(t0, t0 + (30 - RIDE.timerWarnMinutes) * 60_000, 30).state).toBe('warn')
    expect(rideTimer(t0, t0 + 31 * 60_000, 30)).toMatchObject({ leftS: -60, state: 'over' })
    expect(rideTimer(t0, t0 + 90 * 60_000, null)).toEqual({ elapsedS: 5400, leftS: null, state: 'ok' })
    expect(rideTimer(t0, t0 - 5000, 30).elapsedS).toBe(0) // clock skew never goes negative
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
