// The only module that touches Web Storage. Every access is wrapped: private mode, quota errors,
// disabled storage and SSR all degrade to an in-memory store instead of crashing the app.

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

const fallbacks: Partial<Record<'local' | 'session', KeyValueStorage>> = {}

function probe(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
    if (!s) return null
    const k = '__bcycle_probe__'
    s.setItem(k, '1')
    s.removeItem(k)
    return s
  } catch {
    return null
  }
}

/** Storage that never throws; falls back to memory when Web Storage is unavailable. */
export function safeStorage(kind: 'local' | 'session' = 'local'): KeyValueStorage {
  const real = probe(kind)
  if (!real) return (fallbacks[kind] ??= memoryStorage())
  return {
    getItem: (k) => {
      try {
        return real.getItem(k)
      } catch {
        return null
      }
    },
    setItem: (k, v) => {
      try {
        real.setItem(k, v)
      } catch {
        /* quota exceeded or disabled — drop silently */
      }
    },
    removeItem: (k) => {
      try {
        real.removeItem(k)
      } catch {
        /* ignore */
      }
    },
  }
}

