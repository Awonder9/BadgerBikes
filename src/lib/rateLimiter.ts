// FIFO request scheduler: enforces a minimum spacing between request *starts*. Used by the Worker's
// UpstreamGate (which layers priorities, deadlines and a circuit breaker on top) and as a per-isolate
// fallback when the gate binding is unavailable.
import { AppError } from './errors'

interface QueuedTask {
  run: () => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface SchedulerClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class HostScheduler {
  private readonly queue: QueuedTask[] = []
  private lastStart = -Infinity
  private timer: unknown = null
  readonly minIntervalMs: number
  private readonly clock: SchedulerClock

  constructor(minIntervalMs: number, clock: SchedulerClock = realClock) {
    this.minIntervalMs = minIntervalMs
    this.clock = clock
  }

  /** Number of tasks waiting for a slot (not counting running ones). */
  get pending(): number {
    return this.queue.length
  }

  /**
   * Runs `task` once a slot is available. If `signal` aborts while the task is still queued, the
   * task is dropped and the returned promise rejects with AppError('aborted') (no slot is consumed).
   */
  schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new AppError('aborted', 'Aborted'))
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask = {
        signal,
        run: () => {
          // Guard against synchronous throws so the scheduler never wedges.
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
        },
      }
      if (signal) {
        entry.onAbort = () => {
          const i = this.queue.indexOf(entry)
          if (i >= 0) {
            this.queue.splice(i, 1)
            reject(new AppError('aborted', 'Aborted'))
            this.pump()
          }
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry)
      this.pump()
    })
  }

  private pump(): void {
    if (this.timer !== null || this.queue.length === 0) return
    const wait = this.lastStart + this.minIntervalMs - this.clock.now()
    if (wait > 0) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null
        this.pump()
      }, wait)
      return
    }
    const entry = this.queue.shift()!
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
    this.lastStart = this.clock.now()
    entry.run()
    if (this.queue.length > 0) this.pump()
  }
}
