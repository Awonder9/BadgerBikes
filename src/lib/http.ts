// The single gateway for network access (client → /api, Worker → upstreams): JSON over fetch with a
// timeout, AbortSignal support, typed AppErrors, and de-duplication of identical in-flight GETs.
// Upstream rate limiting is NOT done here — the Worker acquires a slot from the UpstreamGate first.
import { HTTP } from '../config'
import { AppError, isAbort, isApiErrorBody } from './errors'

export interface RequestOptions {
  signal?: AbortSignal
  /** Overrides HTTP.timeoutMs. */
  timeoutMs?: number
  /** Share one underlying request between identical concurrent GETs (default true). */
  dedupe?: boolean
  headers?: Record<string, string>
  /** Browser cache mode (the client uses 'no-store' for live data). Not sent from the Worker. */
  cache?: RequestInit['cache']
  /** Upstream name for error attribution ('valhalla', 'gbfs', …). */
  provider?: string
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchImpl = (input, init) => globalThis.fetch(input, init)
const inflight = new Map<string, { promise: Promise<unknown>; controller: AbortController; refs: number }>()

/** Test hook: replace the underlying fetch. Returns a function that restores the previous one. */
export function setFetchImpl(impl: FetchImpl): () => void {
  const prev = fetchImpl
  fetchImpl = impl
  return () => {
    fetchImpl = prev
  }
}

/** Test hook: forget in-flight requests. */
export function resetHttpState(): void {
  inflight.clear()
}

function redact(url: string): string {
  // Long Valhalla `json=` query strings make error messages unreadable.
  return url.length > 160 ? `${url.slice(0, 157)}...` : url
}

interface RawRequest {
  url: string
  method: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  cache?: RequestInit['cache']
  provider?: string
}

interface Sent {
  res: Response
  /** Clears the timeout and listeners; call once the body has been consumed. */
  done: () => void
  /** True once the timeout fired (also while the body is still being read). */
  timedOut: () => boolean
}

/** Performs one request with a timeout; resolves to the Response (status not yet checked). */
async function send(req: RawRequest, signal: AbortSignal, timeoutMs: number): Promise<Sent> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const done = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  const init: RequestInit = {
    method: req.method,
    signal: controller.signal,
    headers: { Accept: 'application/json', ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
  }
  if (req.body !== undefined) init.body = req.body
  if (req.cache) init.cache = req.cache
  try {
    const res = await fetchImpl(req.url, init)
    return { res, done, timedOut: () => timedOut }
  } catch (err) {
    done()
    if (timedOut) throw new AppError('timeout', `Request timed out after ${timeoutMs} ms: ${redact(req.url)}`, { provider: req.provider })
    if (signal.aborted || isAbort(err)) throw new AppError('aborted', 'Aborted', { provider: req.provider })
    throw new AppError('network', `Network request failed: ${redact(req.url)}`, { provider: req.provider, cause: err })
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return undefined
  const looksJson = contentType === null || contentType.includes('json') || /^\s*[[{]/.test(text)
  if (!looksJson) return text
  return JSON.parse(text)
}

function errorFor(res: Response, body: unknown, req: RawRequest): AppError {
  if (isApiErrorBody(body)) {
    // Our own API: keep the server's code.
    return new AppError(body.error.code, body.error.message, { status: res.status, provider: req.provider, retryable: body.error.retryable, body })
  }
  if (res.status === 429) {
    return new AppError('rate_limited', `Rate limited by ${req.provider ?? 'server'}`, { status: 429, provider: req.provider, body })
  }
  return new AppError('http', `HTTP ${res.status} for ${redact(req.url)}`, { status: res.status, provider: req.provider, body })
}

async function requestJson<T>(req: RawRequest, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const { res, done, timedOut } = await send(req, signal, timeoutMs)
  try {
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      if (timedOut()) throw new AppError('timeout', `Request timed out after ${timeoutMs} ms: ${redact(req.url)}`, { provider: req.provider })
      if (signal.aborted) throw new AppError('aborted', 'Aborted', { provider: req.provider })
      throw new AppError('network', `Failed reading response: ${redact(req.url)}`, { provider: req.provider, cause: err })
    }
    let body: unknown
    try {
      body = parseBody(text, res.headers.get('content-type'))
    } catch (err) {
      if (!res.ok) body = text
      else throw new AppError('bad_response', `Invalid JSON from ${redact(req.url)}`, { status: res.status, provider: req.provider, cause: err })
    }
    if (!res.ok) throw errorFor(res, body, req)
    return body as T
  } finally {
    done()
  }
}

function neverAborted(): AbortSignal {
  return new AbortController().signal
}

/**
 * GET `url` and parse JSON. Rejects with AppError ('aborted' | 'network' | 'timeout' | 'http' |
 * 'rate_limited' | 'bad_response', or the server's code for our own API errors).
 * Identical concurrent GETs share one request; it is cancelled only when every caller has aborted.
 */
export function fetchJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { signal, timeoutMs = HTTP.timeoutMs, dedupe = true } = opts
  if (signal?.aborted) return Promise.reject(new AppError('aborted', 'Aborted', { provider: opts.provider }))
  const req: RawRequest = { url, method: 'GET', headers: opts.headers, cache: opts.cache, provider: opts.provider }
  if (!dedupe) return requestJson<T>(req, signal ?? neverAborted(), timeoutMs)

  let entry = inflight.get(url)
  if (!entry) {
    const controller = new AbortController()
    const promise = requestJson<T>(req, controller.signal, timeoutMs)
    const created = { promise: promise as Promise<unknown>, controller, refs: 0 }
    entry = created
    inflight.set(url, created)
    const cleanup = () => {
      if (inflight.get(url) === created) inflight.delete(url)
    }
    promise.then(cleanup, cleanup)
  }
  const shared = entry
  shared.refs++

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      shared.refs--
      if (shared.refs <= 0) {
        shared.controller.abort()
        if (inflight.get(url) === shared) inflight.delete(url)
      }
      reject(new AppError('aborted', 'Aborted', { provider: opts.provider }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      shared.refs--
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    shared.promise.then(
      (value) => finish(() => resolve(value as T)),
      (err: unknown) => finish(() => reject(err)),
    )
  })
}

/** POST a JSON body and parse the JSON response. Never de-duplicated. */
export function postJson<T>(url: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
  const { signal, timeoutMs = HTTP.timeoutMs } = opts
  if (signal?.aborted) return Promise.reject(new AppError('aborted', 'Aborted', { provider: opts.provider }))
  const req: RawRequest = { url, method: 'POST', body: JSON.stringify(body), headers: opts.headers, cache: opts.cache, provider: opts.provider }
  return requestJson<T>(req, signal ?? neverAborted(), timeoutMs)
}
