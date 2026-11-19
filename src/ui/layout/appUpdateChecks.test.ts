import { describe, expect, it, vi } from 'vitest'
import { POLL } from '../../config'
import { startAppUpdateChecks, type UpdateCheckEnv } from './appUpdateChecks'

function setup() {
  const listeners = new Map<string, () => void>()
  let intervalFn: (() => void) | undefined
  let time = 1_000_000
  const doc = { visibilityState: 'visible' as DocumentVisibilityState }
  const env = {
    document: {
      get visibilityState() {
        return doc.visibilityState
      },
      addEventListener: (type: string, fn: () => void) => listeners.set(`doc:${type}`, fn),
      removeEventListener: (type: string) => listeners.delete(`doc:${type}`),
    },
    window: {
      addEventListener: (type: string, fn: () => void) => listeners.set(`win:${type}`, fn),
      removeEventListener: (type: string) => listeners.delete(`win:${type}`),
      setInterval: (fn: () => void) => {
        intervalFn = fn
        return 1
      },
      clearInterval: () => {
        intervalFn = undefined
      },
    },
    isOnline: () => true,
    now: () => time,
  } as unknown as UpdateCheckEnv
  const registration = { installing: null as unknown, update: vi.fn<() => Promise<void>>(() => Promise.resolve()) }
  const stop = startAppUpdateChecks(registration, env)
  return {
    registration,
    stop,
    doc,
    listeners,
    fire: (key: string) => listeners.get(key)?.(),
    tick: () => intervalFn?.(),
    advance: (ms: number) => {
      time += ms
    },
  }
}

describe('startAppUpdateChecks', () => {
  it('checks when the app returns to the foreground', () => {
    const s = setup()
    s.advance(POLL.appUpdateMinGapMs)
    s.doc.visibilityState = 'visible'
    s.fire('doc:visibilitychange')
    expect(s.registration.update).toHaveBeenCalledTimes(1)
  })

  it('does not check again for foreground events close together', () => {
    const s = setup()
    s.advance(POLL.appUpdateMinGapMs)
    s.fire('win:pageshow')
    s.fire('win:focus')
    s.fire('doc:visibilitychange')
    expect(s.registration.update).toHaveBeenCalledTimes(1)
  })

  it('skips checks while hidden or while a new worker is installing', () => {
    const s = setup()
    s.advance(POLL.appUpdateMinGapMs)
    s.doc.visibilityState = 'hidden'
    s.tick()
    s.fire('doc:visibilitychange')
    s.doc.visibilityState = 'visible'
    s.registration.installing = {}
    s.tick()
    expect(s.registration.update).not.toHaveBeenCalled()
  })

  it('checks on the interval while open, and stops cleanly', () => {
    const s = setup()
    s.tick()
    expect(s.registration.update).toHaveBeenCalledTimes(1)
    s.stop()
    s.tick()
    expect(s.listeners.size).toBe(0)
    expect(s.registration.update).toHaveBeenCalledTimes(1)
  })

  it('swallows update failures', async () => {
    const s = setup()
    s.registration.update.mockImplementation(() => Promise.reject(new Error('offline')))
    s.tick()
    await Promise.resolve()
    expect(s.registration.update).toHaveBeenCalledTimes(1)
  })
})
