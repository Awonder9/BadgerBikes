/** Small LRU cache with optional per-entry TTL. `now` is injectable for tests. */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(maxEntries: number, ttlMs = Infinity, now: () => number = () => Date.now()) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = now
  }

  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires <= this.now()) {
      this.map.delete(key)
      return undefined
    }
    // Refresh recency.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, { value, expires: this.now() + this.ttlMs })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
