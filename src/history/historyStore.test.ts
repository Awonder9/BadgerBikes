import { beforeEach, describe, expect, it } from 'vitest'
import { restoreHistory, useHistoryStore } from './historyStore'
import type { RideRecord } from './rides'

const T0 = 1_800_000_000_000
const ride = (id: string, o: Partial<RideRecord> = {}): RideRecord => ({
  id,
  systemId: 'bcycle_madison',
  startedAtMs: T0,
  endedAtMs: T0 + 600_000,
  endEstimated: false,
  startName: 'Capitol',
  startStationId: 'cap',
  endName: 'Union',
  endStationId: 'mu',
  destName: null,
  meters: 2000,
  plannedS: 600,
  electric: false,
  kind: 'ride',
  line: null,
  pathM: {},
  climbM: null,
  highlights: [],
  stravaActivityId: null,
  ...o,
})

describe('the ride history on the device', () => {
  beforeEach(() => useHistoryStore.setState({ rides: [], active: null, seenReviews: [], recording: true }))

  it('can be deleted all at once, reviews seen included', () => {
    useHistoryStore.setState({ rides: [ride('a'), ride('b')], seenReviews: ['week:2026-11-16'] })
    useHistoryStore.getState().add(ride('c', { startedAtMs: T0 + 3_600_000, endedAtMs: null }), 'k', true)
    useHistoryStore.getState().clear()
    expect(useHistoryStore.getState()).toMatchObject({ rides: [], active: null, seenReviews: [], recording: true })
  })

  it('stops recording when the rider turns it off: the ride being recorded is dropped, finished ones stay', () => {
    useHistoryStore.setState({ rides: [ride('a')] })
    useHistoryStore.getState().add(ride('c', { startedAtMs: T0 + 3_600_000, endedAtMs: null }), 'k', true)
    useHistoryStore.getState().setRecording(false)
    expect(useHistoryStore.getState()).toMatchObject({ recording: false, active: null })
    expect(useHistoryStore.getState().rides.map((r) => r.id)).toEqual(['a'])
  })

  it('remembers that recording is off (and is on unless the rider turned it off)', () => {
    expect(restoreHistory({ rides: [], recording: false }).recording).toBe(false)
    expect(restoreHistory({ rides: [] }).recording).toBe(true)
    expect(restoreHistory(null).recording).toBe(true)
  })
})
