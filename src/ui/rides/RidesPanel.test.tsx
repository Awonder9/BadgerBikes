import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HISTORY } from '../../config'
import { createQueryClient } from '../../data/hooks'
import { useHistoryStore } from '../../history/historyStore'
import type { RideRecord } from '../../history/rides'
import { resetHttpState, setFetchImpl } from '../../lib/http'
import { initialAppState, useAppStore } from '../../store/appStore'
import { RidesPanel } from './RidesPanel'

const T0 = Date.UTC(2026, 9, 1, 17)
const ride = (n: number): RideRecord => ({
  id: `r${n}`,
  systemId: 'bcycle_madison',
  startedAtMs: T0 - n * 86_400_000,
  endedAtMs: T0 - n * 86_400_000 + 600_000,
  endEstimated: false,
  startName: `Dock ${n}`,
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
})

function show() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RidesPanel />
    </QueryClientProvider>,
  )
}

describe('"Your rides"', () => {
  let restore: (() => void) | null = null
  beforeEach(() => {
    resetHttpState()
    // No Strava on this server.
    restore = setFetchImpl(async () => new Response(JSON.stringify({ contactEmail: null, version: 't', pushPublicKey: null, stravaClientId: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    useAppStore.setState({ ...initialAppState })
    useHistoryStore.setState({ rides: [ride(1), ride(2)], active: null, seenReviews: [], recording: true })
  })
  afterEach(() => {
    cleanup()
    restore?.()
  })

  it('asks before deleting a ride', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /Dock 1 → Union/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete this ride' }))
    expect(useHistoryStore.getState().rides).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete this ride' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(useHistoryStore.getState().rides.map((r) => r.id)).toEqual(['r2'])
  })

  it('deletes every ride after asking, and recording can be turned off', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all rides' }))
    expect(screen.getByText('Delete all 2 rides from this device? This can’t be undone.')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete all rides' })[0]!)
    expect(useHistoryStore.getState().rides).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: /Record my rides/ }))
    expect(useHistoryStore.getState().recording).toBe(false)
  })

  it('lists a long history a page at a time, so every ride can be reached', () => {
    useHistoryStore.setState({ rides: Array.from({ length: HISTORY.listPageSize + 5 }, (_, i) => ride(i + 1)) })
    show()
    expect(screen.queryByRole('button', { name: new RegExp(`Dock ${HISTORY.listPageSize + 5} →`) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more rides' }))
    expect(screen.getByRole('button', { name: new RegExp(`Dock ${HISTORY.listPageSize + 5} →`) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull()
  })
})
