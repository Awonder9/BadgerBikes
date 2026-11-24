// The ride history store: rides recorded on this device (src/history/rides.ts), the ride being recorded now, and
// which reviews the rider has already opened. Persisted in localStorage (`bcycle.history`), validated on restore,
// never sent anywhere — except a ride the rider chooses to send to Strava.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { safeStorage } from '../lib/storage'
import { capRides, validateRide, type RideRecord } from './rides'

export interface HistoryState {
  /** Newest first. */
  rides: RideRecord[]
  /** The ride being recorded (endedAtMs null), with the plan it belongs to (start dock, end, route) as a key. */
  active: { id: string; planKey: string } | null
  /** Reviews already opened: "week:2026-11-17", "month:2026-11", "year:2026". */
  seenReviews: string[]
  add(ride: RideRecord, planKey: string): void
  update(id: string, patch: Partial<RideRecord>): void
  /** Ends the active ride: its end (or, null, drops it: too short to have been a ride). */
  closeActive(end: { endedAtMs: number; endEstimated: boolean } | null): void
  remove(id: string): void
  markSeen(key: string): void
  clear(): void
}

const MAX_SEEN = 200

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      rides: [],
      active: null,
      seenReviews: [],
      add: (ride, planKey) => set((s) => ({ rides: capRides([ride, ...s.rides.filter((r) => r.id !== ride.id)]), active: { id: ride.id, planKey } })),
      update: (id, patch) => set((s) => ({ rides: s.rides.map((r) => (r.id === id ? { ...r, ...patch, id } : r)) })),
      closeActive: (end) =>
        set((s) => {
          if (!s.active) return s
          const id = s.active.id
          return { active: null, rides: end ? s.rides.map((r) => (r.id === id ? { ...r, ...end } : r)) : s.rides.filter((r) => r.id !== id) }
        }),
      remove: (id) => set((s) => ({ rides: s.rides.filter((r) => r.id !== id), active: s.active?.id === id ? null : s.active })),
      markSeen: (key) => set((s) => (s.seenReviews.includes(key) ? s : { seenReviews: [...s.seenReviews, key].slice(-MAX_SEEN) })),
      clear: () => set({ rides: [], active: null }),
    }),
    {
      name: 'bcycle.history',
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      partialize: (s) => ({ rides: s.rides, active: s.active, seenReviews: s.seenReviews }),
      merge: (persisted, current) => ({ ...current, ...restoreHistory(persisted) }),
    },
  ),
)

/** A stored history, validated record by record (a bad one is dropped, not the whole history). */
export function restoreHistory(raw: unknown): Pick<HistoryState, 'rides' | 'active' | 'seenReviews'> {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const rides = capRides(Array.isArray(o.rides) ? o.rides.map(validateRide).filter((r): r is RideRecord => r !== null) : [])
  const a = o.active as { id?: unknown; planKey?: unknown } | null | undefined
  const active = a && typeof a.id === 'string' && typeof a.planKey === 'string' && rides.some((r) => r.id === a.id && r.endedAtMs === null) ? { id: a.id, planKey: a.planKey.slice(0, 300) } : null
  // A ride left open without being active can't be closed by anyone: drop it.
  const kept = rides.filter((r) => r.endedAtMs !== null || r.id === active?.id)
  const seenReviews = Array.isArray(o.seenReviews) ? o.seenReviews.filter((k): k is string => typeof k === 'string' && /^(week|month|year):[0-9-]{4,10}$/.test(k)).slice(-MAX_SEEN) : []
  return { rides: kept, active, seenReviews }
}
