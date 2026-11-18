// One error type for the whole app (client and Worker). Explicit fields, no constructor parameter
// properties (erasableSyntaxOnly).

export type AppErrorCode =
  // transport
  | 'aborted'
  | 'network'
  | 'timeout'
  | 'http'
  | 'rate_limited'
  | 'bad_response'
  // API / domain
  | 'bad_request'
  | 'not_found'
  | 'unknown_system'
  | 'no_route'
  /** A user-supplied point is too far from any street/path (Valhalla 170/171, OSRM NoSegment). */
  | 'location_unroutable'
  /** Upstream circuit open or upstream down; callers fall back to estimates. */
  | 'upstream_unavailable'
  | 'internal'
  // device
  | 'geo_denied'
  | 'geo_unavailable'
  | 'geo_timeout'
  | 'geo_unsupported'
  | 'webgl_unavailable'

const RETRYABLE: ReadonlySet<AppErrorCode> = new Set(['network', 'timeout', 'rate_limited', 'upstream_unavailable'])

export interface AppErrorInit {
  status?: number
  provider?: string
  retryable?: boolean
  /** Parsed error payload from the server, if any. */
  body?: unknown
  cause?: unknown
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number | undefined
  readonly provider: string | undefined
  readonly retryable: boolean
  readonly body: unknown

  constructor(code: AppErrorCode, message: string, init: AppErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AppError'
    this.code = code
    this.status = init.status
    this.provider = init.provider
    this.retryable = init.retryable ?? (RETRYABLE.has(code) || (init.status !== undefined && init.status >= 500))
    this.body = init.body
  }
}

export function isAbort(err: unknown): boolean {
  if (err instanceof AppError) return err.code === 'aborted'
  return err instanceof Error && err.name === 'AbortError'
}

export function isAppError(err: unknown, code?: AppErrorCode): err is AppError {
  return err instanceof AppError && (code === undefined || err.code === code)
}

/** Normalizes anything thrown into an AppError (unknown errors become 'internal'). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if (err instanceof Error && err.name === 'AbortError') return new AppError('aborted', 'Aborted', { cause: err })
  const message = err instanceof Error ? err.message : String(err)
  return new AppError('internal', message || 'Unexpected error', { cause: err })
}

/** Wire format for API errors ({ error: { code, message, retryable } }). */
export interface ApiErrorBody {
  error: { code: AppErrorCode; message: string; retryable: boolean }
}

export function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false
  const e = (body as { error: unknown }).error
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
}
