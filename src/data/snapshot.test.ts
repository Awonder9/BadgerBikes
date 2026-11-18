import { beforeEach, describe, expect, it } from 'vitest'
import type { StationsResponse } from '../api/contract'
import { POLL } from '../config'
import { makeStation } from '../test/factories'
import { freshnessOf, statusPollInterval, toClientSnapshot } from './snapshot'
import { searchStations } from './stationSearch'
import { getTrend, recordSnapshot, resetTrends, trendDelta } from './trend'

const T0 = 1_800_000_000_000

/** Fixed names so identical inputs really are identical (makeStation auto-numbers names). */
const st = (id: string, bikes: number, docks = 5) => makeStation({ id, name: `Station ${id}`, bikes, docks })

function response(stations = [st('a', 3), st('b', 0)], lastUpdatedMs = T0): StationsResponse {
  return { systemId: 'bcycle_madison', lastUpdatedMs, fetchedAtMs: lastUpdatedMs + 500, stations }
}

describe('toClientSnapshot', () => {
  it('starts at revision 1 and tracks changes', () => {
    const s1 = toClientSnapshot(response(), null)
    expect(s1.revision).toBe(1)
    expect(s1.byId.get('a')?.status?.bikes).toBe(3)

    // Same data + same feed time → identical object.
    expect(toClientSnapshot(response(), s1)).toBe(s1)

    // Same data, newer feed time → same revision, new freshness.
    const s2 = toClientSnapshot(response(undefined, T0 + 60_000), s1)
    expect(s2.revision).toBe(1)
    expect(s2.lastUpdatedMs).toBe(T0 + 60_000)

    // One count changes → revision++ and only that id in changedIds.
    const s3 = toClientSnapshot(response([st('a', 2), st('b', 0)], T0 + 120_000), s2)
    expect(s3.revision).toBe(2)
    expect([...s3.changedIds]).toEqual(['a'])

    // A station disappears → counted as a change.
    const s4 = toClientSnapshot(response([st('a', 2)], T0 + 180_000), s3)
    expect(s4.revision).toBe(3)
    expect(s4.changedIds.has('b')).toBe(true)

    // Different system resets the revision.
    expect(toClientSnapshot({ ...response(), systemId: 'bcycle_indego' }, s4).revision).toBe(1)
  })
})

describe('statusPollInterval / freshnessOf', () => {
  it('polls right after the CDN expiry, clamped, and slower when stale', () => {
    expect(statusPollInterval(T0, T0 + 5_000, false)).toBe(POLL.statusAfterFeedMs - 5_000)
    expect(statusPollInterval(T0, T0 + 62_000, false)).toBe(POLL.statusMinMs)
    expect(statusPollInterval(T0, T0 + 1_000, true)).toBe(POLL.statusActiveMaxMs)
    expect(statusPollInterval(T0, T0 + POLL.staleAfterMs + 1, false)).toBe(30_000)
    expect(statusPollInterval(undefined, T0, false)).toBe(30_000)
  })

  it('classifies freshness', () => {
    expect(freshnessOf({ hasData: false, isError: false, lastUpdatedMs: undefined, nowMs: T0 })).toBe('loading')
    expect(freshnessOf({ hasData: false, isError: true, lastUpdatedMs: undefined, nowMs: T0 })).toBe('error')
    expect(freshnessOf({ hasData: true, isError: true, lastUpdatedMs: T0, nowMs: T0 })).toBe('stale')
    expect(freshnessOf({ hasData: true, isError: false, lastUpdatedMs: T0, nowMs: T0 + POLL.staleAfterMs + 1 })).toBe('stale')
    expect(freshnessOf({ hasData: true, isError: false, lastUpdatedMs: T0, nowMs: T0 + 10_000 })).toBe('fresh')
  })
})

describe('trend', () => {
  beforeEach(() => resetTrends())

  it('records one point per distinct feed time and computes deltas', () => {
    let prev = null
    for (let i = 0; i <= 10; i++) {
      const snap = toClientSnapshot(response([st('a', 10 - i, i)], T0 + i * 60_000), prev)
      recordSnapshot(snap)
      recordSnapshot(snap) // duplicate feed time ignored
      prev = snap
    }
    const pts = getTrend('bcycle_madison', 'a')
    expect(pts).toHaveLength(11)
    expect(trendDelta(pts, 'bikes', 10 * 60_000)).toEqual({ delta: -10, spanMs: 10 * 60_000 })
    expect(trendDelta(pts, 'docks', 5 * 60_000)?.delta).toBe(5)
    expect(trendDelta(pts.slice(0, 1), 'bikes', 60_000)).toBeNull()
  })
})

describe('searchStations', () => {
  const stations = [
    makeStation({ id: '1', name: 'Wisconsin & E. Mifflin' }),
    makeStation({ id: '2', name: 'State St & Lake St' }),
    makeStation({ id: '3', name: 'Memorial Union' }),
    makeStation({ id: '4', name: 'Observatory Dr. @ Bascom Hall' }),
  ]
  it('matches word prefixes with punctuation-insensitive normalization', () => {
    expect(searchStations(stations, 'mem').map((m) => m.station.id)).toEqual(['3'])
    expect(searchStations(stations, 'state & lake').map((m) => m.station.id)).toEqual(['2'])
    expect(searchStations(stations, 'state and lake street').map((m) => m.station.id)).toEqual(['2'])
    expect(searchStations(stations, 'bascom').map((m) => m.station.id)).toEqual(['4'])
    expect(searchStations(stations, 'mifflin wis').map((m) => m.station.id)).toEqual(['1'])
    expect(searchStations(stations, 'zzz')).toEqual([])
    expect(searchStations(stations, '  ')).toEqual([])
  })
})
