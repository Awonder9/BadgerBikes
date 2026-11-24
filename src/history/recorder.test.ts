import { describe, expect, it } from 'vitest'
import { HISTORY } from '../config'
import { recorderStep, type RideFields } from './recorder'
import type { RideRecord } from './rides'

const T0 = 1_800_000_000_000
const fields: RideFields = {
  systemId: 'bcycle_madison', startName: 'Capitol', startStationId: 'cap', endName: 'Union', endStationId: 'mu', destName: 'Union', meters: 2000, plannedS: 600,
  electric: true, kind: 'ride', line: null, pathM: {}, climbM: null, highlights: [],
}
const id = (at: number) => `r${at}`
const rec = (o: Partial<RideRecord> = {}): RideRecord => ({ id: 'r1', startedAtMs: T0, endedAtMs: null, endEstimated: false, stravaActivityId: null, ...fields, ...o })

describe('ride recorder', () => {
  it('starts a record when the timer starts, at the timer’s start', () => {
    expect(recorderStep(null, { underWay: true, startedAtMs: null, plan: { key: 'k', fields }, seenUnderWay: true }, T0, id)).toEqual({ kind: 'none' }) // walking to the dock
    const s = recorderStep(null, { underWay: true, startedAtMs: T0 - 5000, plan: { key: 'k', fields }, seenUnderWay: true }, T0, id)
    expect(s).toMatchObject({ kind: 'start', planKey: 'k', close: 'none', ride: { id: `r${T0 - 5000}`, startedAtMs: T0 - 5000, endedAtMs: null } })
    // Stations still loading after a reload: wait.
    expect(recorderStep(null, { underWay: true, startedAtMs: T0, plan: null, seenUnderWay: true }, T0, id)).toEqual({ kind: 'none' })
  })

  it('follows the same plan (another end dock, path details) without restarting', () => {
    const s = recorderStep({ record: rec(), planKey: 'k' }, { underWay: true, startedAtMs: T0 + 60_000, plan: { key: 'k', fields: { ...fields, endName: 'Library' } }, seenUnderWay: true }, T0 + 120_000, id)
    expect(s).toEqual({ kind: 'update', id: 'r1', fields: { ...fields, endName: 'Library' } })
  })

  it('ends a ride the rider ended here then; one whose plan was gone on return gets its planned time', () => {
    expect(recorderStep({ record: rec(), planKey: 'k' }, { underWay: false, startedAtMs: null, plan: null, seenUnderWay: true }, T0 + 14 * 60_000, id)).toEqual({ kind: 'close', end: { endedAtMs: T0 + 14 * 60_000, endEstimated: false } })
    expect(recorderStep({ record: rec(), planKey: 'k' }, { underWay: false, startedAtMs: null, plan: null, seenUnderWay: false }, T0 + 3 * 60 * 60_000, id)).toEqual({ kind: 'close', end: { endedAtMs: T0 + 600_000, endEstimated: true } })
    // Ended right away: a mis-tap, dropped.
    expect(recorderStep({ record: rec(), planKey: 'k' }, { underWay: false, startedAtMs: null, plan: null, seenUnderWay: true }, T0 + (HISTORY.minRideSeconds - 1) * 1000, id)).toEqual({ kind: 'close', end: null })
  })

  it('a new plan mid-ride (next leg on the same bike) ends the last record and starts one now', () => {
    const s = recorderStep({ record: rec(), planKey: 'k' }, { underWay: true, startedAtMs: T0, plan: { key: 'k2', fields }, seenUnderWay: true }, T0 + 20 * 60_000, id)
    expect(s).toMatchObject({ kind: 'start', planKey: 'k2', close: { endedAtMs: T0 + 20 * 60_000, endEstimated: false }, ride: { startedAtMs: T0 + 20 * 60_000 } })
    // Docked and unlocked again (a new timer): the new record starts at it.
    const t = recorderStep({ record: rec(), planKey: 'k' }, { underWay: true, startedAtMs: T0 + 25 * 60_000, plan: { key: 'k2', fields }, seenUnderWay: true }, T0 + 26 * 60_000, id)
    expect(t).toMatchObject({ kind: 'start', ride: { startedAtMs: T0 + 25 * 60_000 } })
  })
})
