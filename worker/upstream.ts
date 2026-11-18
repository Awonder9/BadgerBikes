// UpstreamFetch implementation for the Worker: cache (per-isolate LRU + Cache API) → global gate →
// fetch with the app User-Agent → outcome reporting.
import { APP, UPSTREAM, type Priority, type UpstreamGroup } from '../src/config'
import { AppError, isAbort } from '../src/lib/errors'
import { fetchJson, postJson } from '../src/lib/http'
import { LruCache } from '../src/lib/lru'
import { HostScheduler } from '../src/lib/rateLimiter'
import type { UpstreamFetch, UpstreamRequest } from '../src/lib/upstream'
import type { GateGrant, GateOutcome } from './gateCore'

/** The subset of the gate the upstream layer needs (the DO stub, or a fake in tests). */
export interface Gate {
  acquire(group: UpstreamGroup, priority: Priority): Promise<GateGrant>
  release(ticket: string, outcome: GateOutcome): Promise<void>
}

export interface UpstreamDeps {
  /** Resolves the gate for a group; null → per-isolate HostScheduler fallback. */
  gateFor: (group: UpstreamGroup) => Gate | null
  contactEmail?: string | null
  now?: () => number
  /** Cache API (caches.default) when available. */
  cache?: Cache | null
  /**
   * Keeps work the response doesn't wait for alive after it is sent (ctx.waitUntil): Cache API writes and
   * gate releases. Without it (tests) that work is awaited / fire-and-forget.
   */
  waitUntil?: (work: Promise<unknown>) => void
}

const memory = new LruCache<string, { body: unknown; expires: number }>(500)
const fallbackSchedulers = new Map<string, HostScheduler>()
const CACHE_ORIGIN = 'https://cache.bcycle-live.internal/'

/** Test hook. */
export function resetUpstreamState(): void {
  memory.clear()
  fallbackSchedulers.clear()
}

function outcomeOf(err: unknown): GateOutcome {
  if (isAbort(err)) return 'aborted'
  if (err instanceof AppError) {
    if (err.code === 'rate_limited' || err.status === 503) return 'rate_limited'
    if (err.code === 'network' || err.code === 'timeout' || (err.status !== undefined && err.status >= 500)) return 'error'
  }
  return 'ok'
}

export function createUpstream(deps: UpstreamDeps): UpstreamFetch {
  const now = deps.now ?? (() => Date.now())
  const userAgent = deps.contactEmail ? `${APP.userAgent} contact: ${deps.contactEmail}` : APP.userAgent

  async function cacheGet(key: string): Promise<unknown> {
    const hit = memory.get(key)
    if (hit && hit.expires > now()) return hit.body
    if (!deps.cache) return undefined
    try {
      const res = await deps.cache.match(CACHE_ORIGIN + encodeURIComponent(key))
      if (!res) return undefined
      const stored = (await res.json()) as { body: unknown; expires: number }
      if (stored.expires <= now()) return undefined
      memory.set(key, stored)
      return stored.body
    } catch {
      return undefined
    }
  }

  async function cachePut(key: string, body: unknown, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    const entry = { body, expires: now() + ttlMs }
    memory.set(key, entry)
    if (!deps.cache) return
    try {
      await deps.cache.put(
        CACHE_ORIGIN + encodeURIComponent(key),
        new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.ceil(ttlMs / 1000)}` } }),
      )
    } catch {
      /* best effort (Cache API may be unavailable on some hostnames) */
    }
  }

  async function doFetch<T>(req: UpstreamRequest): Promise<T> {
    const opts = { signal: req.signal, provider: req.provider, headers: { 'User-Agent': userAgent } }
    return req.method === 'POST' ? postJson<T>(req.url, req.body, opts) : fetchJson<T>(req.url, { ...opts, dedupe: true })
  }

  /**
   * Returns a slot to the gate. It must arrive even after the response has gone out: with FOSSGIS's single
   * slot, a lost release blocks every route request until the gate reclaims it (30 s).
   */
  function release(gate: Gate, ticket: string, outcome: GateOutcome): void {
    if (!ticket) return
    const done = gate.release(ticket, outcome).catch(() => {})
    deps.waitUntil?.(done)
  }

  return async function upstream<T>(req: UpstreamRequest): Promise<T> {
    if (req.cacheKey) {
      const cached = await cacheGet(req.cacheKey)
      if (cached !== undefined) return cached as T
    }
    let result: T
    if (!req.group) {
      result = await doFetch<T>(req)
    } else {
      const gate = deps.gateFor(req.group)
      if (gate) {
        let grant: GateGrant
        try {
          grant = await gate.acquire(req.group, req.priority)
        } catch {
          grant = { ok: true, ticket: '' } // gate unreachable: proceed rather than fail the user
        }
        if (!grant.ok) throw new AppError('upstream_unavailable', `${req.provider} is busy; try again shortly`, { provider: req.provider, retryable: true })
        if (req.signal?.aborted) {
          release(gate, grant.ticket, 'aborted')
          throw new AppError('aborted', 'Aborted')
        }
        try {
          result = await doFetch<T>(req)
          release(gate, grant.ticket, 'ok')
        } catch (err) {
          release(gate, grant.ticket, outcomeOf(err))
          throw err
        }
      } else {
        let s = fallbackSchedulers.get(req.group)
        if (!s) {
          s = new HostScheduler(UPSTREAM.groups[req.group].minSpacingMs)
          fallbackSchedulers.set(req.group, s)
        }
        result = await s.schedule(() => doFetch<T>(req), req.signal)
      }
    }
    if (req.cacheKey && req.cacheTtlMs !== undefined) {
      const ttl = typeof req.cacheTtlMs === 'function' ? req.cacheTtlMs(result) : req.cacheTtlMs
      // The in-isolate copy is stored at once (cachePut sets it before its first await); the Cache API write
      // finishes in the background instead of delaying this response.
      const put = cachePut(req.cacheKey, result, ttl)
      if (deps.waitUntil) deps.waitUntil(put)
      else await put
    }
    return result
  }
}
