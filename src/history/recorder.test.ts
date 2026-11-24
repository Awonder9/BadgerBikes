import { describe, expect, it } from 'vitest'
import { HISTORY } from '../config'
import { recorderStep, type ActiveRecord, type RecorderInput, type RideFields } from './recorder'
import type { RideRecord } from './rides'

const T0 = 1_800_000_000_000
const fields: RideFields = {
  systemId: 'bcycle_madison', startName: 'Capitol', startStationId: 'cap', endName: 'Union', endStationId: 'mu', destName: 'Union', meters: 2000, plannedS: 600,
  electric: true, kind: 'ride', line: null, pathM: {}, climbM: null, highlights: [],
}
const id = (at: number) => `r${at}`
const rec = (o: Partial<RideRecord> = {}): RideRecord => ({ id: 'r1', startedAtMs: T0, endedAtMs: null, endEstimated: false, stravaActivityId: null, ...fields, ...o })
const active = (o: Partial<ActiveRecord> = {}): ActiveRecord => ({ record: rec(), planKey: 'k', ridden: true, ...o })
const input = (o: Partial<RecorderInput> = {}): RecorderInput => ({ underWay: true, startedAtMs: T0, plan: { key: 'k', fields }, seenUnderWay: true, setOff: true, ...o })

describe('ride recorder', () => {
  it('starts a record when the timer starts, at the timer’s start', () => {
    expect(recorderStep(null, input({ startedAtMs: null }), T0, id)).toEqual({ kind: 'none' }) // walking to the dock
    const s = recorderStep(null, input({ startedAtMs: T0 - 5000 }), T0, id)
    expect(s).toMatchObject({ kind: 'start', planKey: 'k', ridden: true, close: 'none', ride: { id: `r${T0 - 5000}`, startedAtMs: T0 - 5000, endedAtMs: null } })
    // Stations still loading after a reload: wait.
    expect(recorderStep(null, input({ plan: null }), T0, id)).toEqual({ kind: 'none' })
  })

  it('follows the same plan (another end dock, path details) without restarting', () => {
    const s = recorderStep(active(), input({ startedAtMs: T0 + 60_000, plan: { key: 'k', fields: { ...fields, endName: 'Library' } } }), T0 + 120_000, id)
    expect(s).toEqual({ kind: 'update', id: 'r1', fields: { ...fields, endName: 'Library' }, planKey: 'k', ridden: true })
  })

  it('writes nothing when the plan says nothing new (every station poll re-runs it mid-ride)', () => {
    const same = { ...fields, pathM: { bikePath: 1200 }, highlights: ['Lake Monona'] }
    const record = rec({ pathM: { bikePath: 1200 }, highlights: ['Lake Monona'] })
    expect(recorderStep(active({ record }), input({ plan: { key: 'k', fields: same } }), T0 + 60_000, id)).toEqual({ kind: 'none' })
    // The path details arrive: that is news.
    const more = { ...same, pathM: { bikePath: 1200, quietStreet: 800 } }
    expect(recorderStep(active({ record }), input({ plan: { key: 'k', fields: more } }), T0 + 60_000, id)).toMatchObject({ kind: 'update' })
    // The rider sets off on the plan: worth remembering (a plan after it is another ride).
    expect(recorderStep(active({ record, ridden: false }), input({ plan: { key: 'k', fields: same } }), T0 + 60_000, id)).toMatchObject({ kind: 'update', ridden: true })
  })

  it('ends a ride the rider ended here then; one whose plan was gone on return gets its planned time', () => {
    const over = input({ underWay: false, startedAtMs: null, plan: null })
    expect(recorderStep(active(), over, T0 + 14 * 60_000, id)).toEqual({ kind: 'close', end: { endedAtMs: T0 + 14 * 60_000, endEstimated: false } })
    expect(recorderStep(active(), { ...over, seenUnderWay: false }, T0 + 3 * 60 * 60_000, id)).toEqual({ kind: 'close', end: { endedAtMs: T0 + 600_000, endEstimated: true } })
    // Ended right away: a mis-tap, dropped.
    expect(recorderStep(active(), over, T0 + (HISTORY.minRideSeconds - 1) * 1000, id)).toEqual({ kind: 'close', end: null })
  })

  it('a new plan mid-ride (next leg on the same bike) ends the last record and starts one now', () => {
    const s = recorderStep(active(), input({ plan: { key: 'k2', fields } }), T0 + 20 * 60_000, id)
    expect(s).toMatchObject({ kind: 'start', planKey: 'k2', close: { endedAtMs: T0 + 20 * 60_000, endEstimated: false }, ride: { startedAtMs: T0 + 20 * 60_000 } })
    // Docked and unlocked again (a new timer): the new record starts at it.
    const t = recorderStep(active(), input({ startedAtMs: T0 + 25 * 60_000, plan: { key: 'k2', fields } }), T0 + 26 * 60_000, id)
    expect(t).toMatchObject({ kind: 'start', ride: { startedAtMs: T0 + 25 * 60_000 } })
  })

  it('another plan before the rider set off (already on a bike, then "Try another ride") replaces it: no ride nobody rode', () => {
    const loop = { ...fields, kind: 'loop' as const, destName: null, highlights: ['Lake Monona'] }
    const s = recorderStep(active({ ridden: false }), input({ plan: { key: 'k2', fields: loop }, setOff: false }), T0 + 8 * 60_000, id)
    expect(s).toEqual({ kind: 'update', id: 'r1', fields: loop, planKey: 'k2', ridden: false })
  })
})
