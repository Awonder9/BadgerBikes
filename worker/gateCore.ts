// Pure scheduling core of the UpstreamGate Durable Object (worker/gate.ts): one instance per upstream
// group. No Cloudflare imports and an injected clock, so every rule is tested in Node with a fake clock.
//
// Rules (docs/ARCHITECTURE.md §4):
//   • priority order interactive > background, FIFO within a priority;
//   • at least `minSpacingMs` between grants (request starts) and at most `maxInFlight` outstanding grants;
//   • a waiter not granted within its priority's queue deadline gets { ok: false, reason: 'deadline' } —
//     immediately, when the queue ahead of it already makes that unavoidable;
//   • circuit breaker: a 'rate_limited' outcome, or `errorThreshold` consecutive 'error' outcomes, opens the
//     circuit for `circuitOpenMs`; while open every acquire (and every queued waiter) fails fast with
//     'circuit_open'. After it closes, one more error re-opens it until an 'ok' resets the count;
//   • a grant that is never released (its caller vanished) is reclaimed after `holdTimeoutMs`.
import { UPSTREAM, type Priority, type UpstreamGroup } from '../src/config'
import { realClock, type SchedulerClock } from '../src/lib/rateLimiter'

/** How the upstream request that used a grant ended. 'aborted' (caller gave up) does not affect the circuit. */
export type GateOutcome = 'ok' | 'rate_limited' | 'error' | 'aborted'
export type GateDenialReason = 'circuit_open' | 'deadline'
export type GateGrant = { ok: true; ticket: string } | { ok: false; reason: GateDenialReason; retryAfterMs: number }

export interface GateCoreConfig {
  minSpacingMs: number
  maxInFlight: number
  circuitOpenMs: number
  queueDeadlineMs: Readonly<Record<Priority, number>>
  /** A grant never released is reclaimed after this long. */
  holdTimeoutMs: number
  /** This many consecutive 'error' outcomes open the circuit. */
  errorThreshold: number
}

export interface GateStats {
  queued: Record<Priority, number>
  inFlight: number
  /** 0 when the circuit is closed. */
  circuitOpenForMs: number
  consecutiveErrors: number
}

/** Upstream requests time out after HTTP.timeoutMs (12 s); a grant held much longer belongs to a vanished caller. */
const HOLD_TIMEOUT_MS = 30_000 // TODO(config): move to src/config.ts (UPSTREAM.holdTimeoutMs)
/** Consecutive network/timeout/5xx outcomes that open the circuit. */
const ERROR_THRESHOLD = 3 // TODO(config): move to src/config.ts (UPSTREAM.circuitErrorThreshold)

export const PRIORITIES: readonly Priority[] = ['interactive', 'background']

export const isPriority = (v: unknown): v is Priority => typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v)
export const isUpstreamGroup = (v: unknown): v is UpstreamGroup => typeof v === 'string' && Object.hasOwn(UPSTREAM.groups, v)

/** Gate configuration for an upstream group, from UPSTREAM in src/config.ts. */
export function gateConfigFor(group: UpstreamGroup): GateCoreConfig {
  const g = UPSTREAM.groups[group]
  return {
    minSpacingMs: g.minSpacingMs,
    maxInFlight: g.maxInFlight,
    circuitOpenMs: g.circuitOpenMs,
    queueDeadlineMs: UPSTREAM.queueDeadlineMs,
    holdTimeoutMs: HOLD_TIMEOUT_MS,
    errorThreshold: ERROR_THRESHOLD,
  }
}

interface Waiter {
  priority: Priority
  resolve: (grant: GateGrant) => void
  deadlineTimer: unknown
}

interface Hold {
  timer: unknown
}

export class GateCore {
  private readonly config: GateCoreConfig
  private readonly clock: SchedulerClock
  private readonly queues: Record<Priority, Waiter[]> = { interactive: [], background: [] }
  private readonly held = new Map<string, Hold>()
  private lastGrantAt = -Infinity
  private openUntil = -Infinity
  private consecutiveErrors = 0
  private pumpTimer: unknown = null
  private readonly ticketPrefix: string
  private ticketSeq = 0

  constructor(config: GateCoreConfig, clock: SchedulerClock = realClock) {
    this.config = config
    this.clock = clock
    // Tickets from a previous instance (e.g. before a Durable Object restart) never collide with ours.
    this.ticketPrefix = Math.max(0, Math.floor(clock.now())).toString(36)
  }

  /**
   * Resolves with a grant once a slot is free, or with a denial: 'circuit_open' (immediately, or when the
   * circuit opens while queued) or 'deadline'. Never rejects. Call release() exactly once per granted ticket.
   */
  acquire(priority: Priority): Promise<GateGrant> {
    const now = this.clock.now()
    if (now < this.openUntil) return Promise.resolve(this.circuitDenial(now))
    const deadlineMs = this.config.queueDeadlineMs[priority]
    const earliestWaitMs = this.earliestWaitMs(priority, now)
    if (earliestWaitMs > deadlineMs) return Promise.resolve({ ok: false, reason: 'deadline', retryAfterMs: earliestWaitMs })
    return new Promise<GateGrant>((resolve) => {
      const waiter: Waiter = { priority, resolve, deadlineTimer: null }
      waiter.deadlineTimer = this.clock.setTimeout(() => this.expire(waiter), deadlineMs)
      this.queues[priority].push(waiter)
      this.pump()
    })
  }

  /**
   * Frees the ticket's slot and records the outcome for the circuit breaker. Returns false (and changes
   * nothing) for unknown tickets, e.g. one already reclaimed by the hold timeout or released twice.
   */
  release(ticket: string, outcome: GateOutcome): boolean {
    const hold = this.held.get(ticket)
    if (!hold) return false
    this.clock.clearTimeout(hold.timer)
    this.held.delete(ticket)
    this.record(outcome)
    this.pump()
    return true
  }

  stats(): GateStats {
    const now = this.clock.now()
    return {
      queued: { interactive: this.queues.interactive.length, background: this.queues.background.length },
      inFlight: this.held.size,
      circuitOpenForMs: Math.max(0, this.openUntil - now),
      consecutiveErrors: this.consecutiveErrors,
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────────────

  private circuitDenial(now: number): GateGrant {
    return { ok: false, reason: 'circuit_open', retryAfterMs: Math.max(0, this.openUntil - now) }
  }

  /** Lower bound on a new waiter's wait: spacing for itself plus everyone served before it. */
  private earliestWaitMs(priority: Priority, now: number): number {
    let ahead = 0
    for (const p of PRIORITIES) {
      ahead += this.queues[p].length
      if (p === priority) break
    }
    const firstSlot = Math.max(now, this.lastGrantAt + this.config.minSpacingMs)
    return firstSlot - now + ahead * this.config.minSpacingMs
  }

  private record(outcome: GateOutcome): void {
    switch (outcome) {
      case 'ok':
        this.consecutiveErrors = 0
        return
      case 'aborted':
        return
      case 'error':
        this.consecutiveErrors++
        if (this.consecutiveErrors >= this.config.errorThreshold) this.openCircuit()
        return
      case 'rate_limited':
        this.openCircuit()
        return
    }
  }

  private openCircuit(): void {
    const now = this.clock.now()
    this.openUntil = now + this.config.circuitOpenMs
    const denial = this.circuitDenial(now)
    for (const p of PRIORITIES) {
      for (const waiter of this.queues[p].splice(0)) {
        this.clock.clearTimeout(waiter.deadlineTimer)
        waiter.resolve(denial)
      }
    }
  }

  private expire(waiter: Waiter): void {
    const queue = this.queues[waiter.priority]
    const i = queue.indexOf(waiter)
    if (i < 0) return
    queue.splice(i, 1)
    waiter.resolve({ ok: false, reason: 'deadline', retryAfterMs: this.earliestWaitMs(waiter.priority, this.clock.now()) })
  }

  private nextWaiter(): Waiter | undefined {
    for (const p of PRIORITIES) {
      const head = this.queues[p][0]
      if (head) return head
    }
    return undefined
  }

  /** Grants as many waiters as spacing and maxInFlight allow; otherwise arms a timer for the next slot. */
  private pump(): void {
    for (;;) {
      const waiter = this.nextWaiter()
      if (!waiter || this.held.size >= this.config.maxInFlight) return
      const now = this.clock.now()
      const readyAt = this.lastGrantAt + this.config.minSpacingMs
      if (readyAt > now) {
        this.armPump(readyAt - now)
        return
      }
      this.queues[waiter.priority].shift()
      this.clock.clearTimeout(waiter.deadlineTimer)
      this.grant(waiter, now)
    }
  }

  private armPump(delayMs: number): void {
    if (this.pumpTimer !== null) return
    this.pumpTimer = this.clock.setTimeout(() => {
      this.pumpTimer = null
      this.pump()
    }, delayMs)
  }

  private grant(waiter: Waiter, now: number): void {
    const ticket = `${this.ticketPrefix}-${++this.ticketSeq}`
    const timer = this.clock.setTimeout(() => this.reclaim(ticket), this.config.holdTimeoutMs)
    this.held.set(ticket, { timer })
    this.lastGrantAt = now
    waiter.resolve({ ok: true, ticket })
  }

  /** Hold timeout: the caller never released (crashed or disconnected). No circuit effect. */
  private reclaim(ticket: string): void {
    if (!this.held.delete(ticket)) return
    this.pump()
  }
}
