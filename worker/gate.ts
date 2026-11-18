// UpstreamGate Durable Object: one instance per upstream group (idFromName(group)). Durable Objects are
// single-threaded, so the in-memory GateCore enforces spacing/priorities/circuit globally for the group.
import { DurableObject } from 'cloudflare:workers'
import type { Priority, UpstreamGroup } from '../src/config'
import { GateCore, gateConfigFor, isPriority, isUpstreamGroup, type GateGrant, type GateOutcome } from './gateCore'

export type { GateGrant, GateOutcome }

export class UpstreamGate extends DurableObject<Env> {
  private core: GateCore | null = null
  private group: UpstreamGroup | null = null

  private coreFor(group: UpstreamGroup): GateCore {
    if (!this.core || this.group !== group) {
      this.core = new GateCore(gateConfigFor(group))
      this.group = group
    }
    return this.core
  }

  async acquire(group: UpstreamGroup, priority: Priority): Promise<GateGrant> {
    if (!isUpstreamGroup(group) || !isPriority(priority)) return { ok: false, reason: 'circuit_open', retryAfterMs: 0 }
    return this.coreFor(group).acquire(priority)
  }

  async release(ticket: string, outcome: GateOutcome): Promise<void> {
    this.core?.release(ticket, outcome)
  }
}
