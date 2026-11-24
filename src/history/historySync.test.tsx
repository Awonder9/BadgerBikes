import { act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useHistoryStore } from './historyStore'

describe('the ride history with the app open in two tabs', () => {
  it('takes over what the other tab saved, so this tab never writes its older copy over those rides', async () => {
    useHistoryStore.setState({ rides: [], active: null, seenReviews: [], recording: true })
    const ride = {
      id: 'other-tab',
      systemId: 'bcycle_madison',
      startedAtMs: 1_800_000_000_000,
      endedAtMs: 1_800_000_600_000,
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
    }
    // The other tab records a ride: its save lands in storage, and this tab hears of it.
    localStorage.setItem('bcycle.history', JSON.stringify({ state: { rides: [ride], active: null, seenReviews: [], recording: true }, version: 1 }))
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'bcycle.history' }))
    })
    expect(useHistoryStore.getState().rides.map((r) => r.id)).toEqual(['other-tab'])
  })
})
