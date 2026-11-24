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
  /**
   * The ride being recorded (endedAtMs null), with the plan it follows (start dock, end, route) as a key; `ridden`: the
   * rider set off on that plan (opened its link, or unlocked a bike for it), so another plan after it is another ride,
   * not a change of plan.
   */
  active: { id: string; planKey: string; ridden: boolean } | null
  /** Reviews already opened: "week:2026-11-17", "month:2026-11", "year:2026". */
  seenReviews: string[]
  /** Rides are recorded (the rider can turn it off: then nothing new is kept, and the ride being recorded is dropped). */
  recording: boolean
  add(ride: RideRecord, planKey: string, ridden: boolean): void
  update(id: string, patch: Partial<RideRecord>): void
  /** The ride being recorded follows `planKey` now (the same plan updated, or another that replaced it). */
  follow(id: string, patch: Partial<RideRecord>, planKey: string, ridden: boolean): void
  /** Ends the active ride: its end (or, null, drops it: too short to have been a ride). */
  closeActive(end: { endedAtMs: number; endEstimated: boolean } | null): void
  remove(id: string): void
  markSeen(key: string): void
  setRecording(on: boolean): void
  /** Deletes every ride (and which reviews were seen) from this device. */
  clear(): void
}

const MAX_SEEN = 200
/** Where the history is kept (localStorage, by zustand's persist). */
const STORE_KEY = 'bcycle.history'

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      rides: [],
      active: null,
      seenReviews: [],
      recording: true,
      add: (ride, planKey, ridden) => set((s) => ({ rides: capRides([ride, ...s.rides.filter((r) => r.id !== ride.id)]), active: { id: ride.id, planKey, ridden } })),
      update: (id, patch) => set((s) => ({ rides: s.rides.map((r) => (r.id === id ? { ...r, ...patch, id } : r)) })),
      follow: (id, patch, planKey, ridden) =>
        set((s) => (s.active?.id === id ? { rides: s.rides.map((r) => (r.id === id ? { ...r, ...patch, id } : r)), active: { id, planKey, ridden } } : s)),
      closeActive: (end) =>
        set((s) => {
          if (!s.active) return s
          const id = s.active.id
          return { active: null, rides: end ? s.rides.map((r) => (r.id === id ? { ...r, ...end } : r)) : s.rides.filter((r) => r.id !== id) }
        }),
      remove: (id) => set((s) => ({ rides: s.rides.filter((r) => r.id !== id), active: s.active?.id === id ? null : s.active })),
      markSeen: (key) => set((s) => (s.seenReviews.includes(key) ? s : { seenReviews: [...s.seenReviews, key].slice(-MAX_SEEN) })),
      setRecording: (on) => set((s) => (on ? { recording: true } : { recording: false, active: null, rides: s.active ? s.rides.filter((r) => r.id !== s.active?.id) : s.rides })),
      clear: () => set({ rides: [], active: null, seenReviews: [] }),
    }),
    {
      name: STORE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage('local')),
      partialize: (s) => ({ rides: s.rides, active: s.active, seenReviews: s.seenReviews, recording: s.recording }),
      merge: (persisted, current) => ({ ...current, ...restoreHistory(persisted) }),
    },
  ),
)

// Another tab of the app saved the history (it recorded, edited or deleted rides): this tab takes it over, or its next
// save would write its own older copy over those rides. (Reading it back writes nothing, so tabs don't ping-pong.)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY || e.key === null) void useHistoryStore.persist.rehydrate()
  })
}

/** A stored history, validated record by record (a bad one is dropped, not the whole history). */
export function restoreHistory(raw: unknown): Pick<HistoryState, 'rides' | 'active' | 'seenReviews' | 'recording'> {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const rides = capRides(Array.isArray(o.rides) ? o.rides.map(validateRide).filter((r): r is RideRecord => r !== null) : [])
  const a = o.active as { id?: unknown; planKey?: unknown; ridden?: unknown } | null | undefined
  const active =
    a && typeof a.id === 'string' && typeof a.planKey === 'string' && rides.some((r) => r.id === a.id && r.endedAtMs === null)
      ? { id: a.id, planKey: a.planKey.slice(0, 300), ridden: a.ridden !== false }
      : null
  // A ride left open without being active can't be closed by anyone: drop it.
  const kept = rides.filter((r) => r.endedAtMs !== null || r.id === active?.id)
  const seenReviews = Array.isArray(o.seenReviews) ? o.seenReviews.filter((k): k is string => typeof k === 'string' && /^(week|month|year):[0-9-]{4,10}$/.test(k)).slice(-MAX_SEEN) : []
  return { rides: kept, active, seenReviews, recording: o.recording !== false }
}
