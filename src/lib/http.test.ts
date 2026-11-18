
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from './errors'
import { fetchJson, postJson, resetHttpState, setFetchImpl } from './http'
import { LruCache } from './lru'
import { HostScheduler } from './rateLimiter'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AppError)
  return (err as AppError).code
}

describe('fetchJson', () => {
  let restore: (() => void) | undefined
  beforeEach(() => resetHttpState())
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it('parses JSON on success', async () => {
    restore = setFetchImpl(async () => jsonResponse({ ok: 1 }))
    await expect(fetchJson('https://example.test/a')).resolves.toEqual({ ok: 1 })
  })

  it('maps non-2xx to AppError("http") with the parsed body', async () => {
    restore = setFetchImpl(async () => jsonResponse({ error_code: 171, error: 'No suitable edges near location' }, 400))
    const err = await fetchJson('https://example.test/b', { provider: 'valhalla' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('http')
    expect((err as AppError).status).toBe(400)
    expect((err as AppError).provider).toBe('valhalla')
    expect((err as AppError).body).toMatchObject({ error_code: 171 })
    expect((err as AppError).retryable).toBe(false)
  })

  it('maps 429 (even with an HTML body) to rate_limited and 5xx to retryable http', async () => {
    restore = setFetchImpl(async () => new Response('<html>429</html>', { status: 429, headers: { 'Content-Type': 'text/html' } }))
    expect(await codeOf(fetchJson('https://example.test/c'))).toBe('rate_limited')
    restore()
    restore = setFetchImpl(async () => jsonResponse({}, 503))
    const err = (await fetchJson('https://example.test/c2').catch((e: unknown) => e)) as AppError
    expect(err.code).toBe('http')
    expect(err.retryable).toBe(true)
  })

  it('passes through our own API error envelope', async () => {
    restore = setFetchImpl(async () => jsonResponse({ error: { code: 'unknown_system', message: 'Unknown system', retryable: false } }, 404))
    const err = (await fetchJson('/api/stations?system=nope').catch((e: unknown) => e)) as AppError
    expect(err.code).toBe('unknown_system')
    expect(err.status).toBe(404)
  })

  it('wraps network failures and invalid JSON', async () => {
    restore = setFetchImpl(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await codeOf(fetchJson('https://example.test/d'))).toBe('network')
    restore()
    restore = setFetchImpl(async () => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    expect(await codeOf(fetchJson('https://example.test/e'))).toBe('bad_response')
  })

  it('times out', async () => {
    restore = setFetchImpl(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    expect(await codeOf(fetchJson('https://example.test/f', { timeoutMs: 20 }))).toBe('timeout')
  })

  it('de-duplicates identical in-flight GETs and only cancels when every caller aborts', async () => {
    let calls = 0
    let resolveFetch: (r: Response) => void = () => {}
    let underlyingSignal: AbortSignal | undefined
    restore = setFetchImpl((_url, init) => {
      calls++
      underlyingSignal = init?.signal ?? undefined
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    })
    const a = new AbortController()
    const p1 = fetchJson('https://example.test/g', { signal: a.signal })
    const p2 = fetchJson('https://example.test/g')
    await Promise.resolve()
    expect(calls).toBe(1)
    a.abort()
    expect(await codeOf(p1)).toBe('aborted')
    expect(underlyingSignal?.aborted).toBe(false)
    resolveFetch(jsonResponse({ shared: true }))
    await expect(p2).resolves.toEqual({ shared: true })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    restore = setFetchImpl(async () => jsonResponse({}))
    const c = new AbortController()
    c.abort()
    expect(await codeOf(fetchJson('https://example.test/h', { signal: c.signal }))).toBe('aborted')
  })
})

describe('postJson', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it('sends a JSON body', async () => {
    let seen: RequestInit | undefined
    restore = setFetchImpl(async (_url, init) => {
      seen = init
      return jsonResponse({ ok: true })
    })
    await expect(postJson('/api/routes', { a: 1 })).resolves.toEqual({ ok: true })
    expect(seen?.method).toBe('POST')
    expect(seen?.body).toBe('{"a":1}')
    const headers = seen?.headers as Record<string, string> | undefined
    expect(headers?.['Content-Type']).toBe('application/json')
  })
})

describe('HostScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('spaces request starts by the minimum interval', async () => {
    const s = new HostScheduler(1000)
    const starts: number[] = []
    const t0 = Date.now()
    const task = async () => {
      starts.push(Date.now() - t0)
      return starts.length
    }
    const all = Promise.all([s.schedule(task), s.schedule(task), s.schedule(task)])
    await vi.advanceTimersByTimeAsync(2500)
    await expect(all).resolves.toEqual([1, 2, 3])
    expect(starts).toEqual([0, 1000, 2000])
  })

  it('drops aborted queued tasks without consuming a slot', async () => {
    const s = new HostScheduler(1000)
    const ran: string[] = []
    const mk = (id: string) => async () => {
      ran.push(id)
    }
    const c = new AbortController()
    const p1 = s.schedule(mk('a'))
    const p2 = s.schedule(mk('b'), c.signal)
    const p3 = s.schedule(mk('c'))
    c.abort()
    expect(await codeOf(p2)).toBe('aborted')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([p1, p3])
    expect(ran).toEqual(['a', 'c'])
  })

  it('survives tasks that throw synchronously', async () => {
    const s = new HostScheduler(0)
    await expect(
      s.schedule(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(s.schedule(async () => 'next')).resolves.toBe('next')
  })
})

describe('LruCache', () => {
  it('evicts least recently used and expires entries', () => {
    let now = 0
    const c = new LruCache<string, number>(2, 100, () => now)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('a')).toBe(1) // a is now most recent
    c.set('c', 3)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(1)
    now = 150
    expect(c.get('a')).toBeUndefined()
  })
})
