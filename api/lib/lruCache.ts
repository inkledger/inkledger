// A bounded in-memory cache: least recently used out first, capped in entries
// and, when given a size per value, in total size (bytes for bodies). An entry
// older than its time to live is gone on read. Values only, never promises:
// load() shares one load per key while it runs, keeps what it resolves to, and
// a load that rejects leaves nothing behind (every caller waiting on it sees
// the rejection, the next call loads again).

export type LruOptions<V> = {
  /** At most this many entries. */
  maxEntries: number;
  /** At most this much in total, as sizeOf counts it (requires sizeOf). */
  maxSize?: number;
  /** A value's size (bytes for a body); a value larger than maxSize is never kept. */
  sizeOf?: (value: V) => number;
  /** Entries older than this are gone on read. */
  ttlMs?: number;
  /** The clock (tests). */
  now?: () => number;
};

type Entry<V> = { value: V; size: number; at: number };

export class LruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly loading = new Map<K, Promise<V | undefined>>();
  private total = 0;
  private readonly maxEntries: number;
  private readonly maxSize: number;
  private readonly sizeOf: (value: V) => number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(o: LruOptions<V>) {
    if (!(o.maxEntries >= 1)) throw new Error("LruCache: maxEntries must be at least 1");
    if (o.maxSize !== undefined && !o.sizeOf) throw new Error("LruCache: maxSize needs sizeOf");
    this.maxEntries = o.maxEntries;
    this.maxSize = o.maxSize ?? Infinity;
    this.sizeOf = o.sizeOf ?? (() => 0);
    this.ttlMs = o.ttlMs ?? Infinity;
    this.now = o.now ?? Date.now;
  }

  /** Entries kept. */
  get size(): number {
    return this.entries.size;
  }

  /** Their total size, as sizeOf counts it. */
  get totalSize(): number {
    return this.total;
  }

  /** The value, now the most recently used; undefined when absent or expired. */
  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** Keeps a value (the oldest go to make room); false when it alone exceeds maxSize (then nothing is kept for the key). */
  set(key: K, value: V): boolean {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxSize) return false;
    this.entries.set(key, { value, size, at: this.now() });
    this.total += size;
    for (const [k] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxSize) break;
      this.delete(k);
    }
    return true;
  }

  delete(key: K): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.total -= e.size;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  /**
   * The cached value, else one load shared by every caller while it runs.
   * What it resolves to is kept (undefined: nothing kept); a rejection is
   * never kept, and reaches every caller waiting on it.
   */
  load(key: K, fn: () => Promise<V | undefined>): Promise<V | undefined> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.loading.get(key);
    if (running) return running;
    const p = (async () => {
      try {
        const value = await fn();
        if (value !== undefined) this.set(key, value);
        return value;
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, p);
    return p;
  }
}
