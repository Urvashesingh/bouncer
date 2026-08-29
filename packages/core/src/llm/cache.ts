/**
 * Tier 5 adjudication cache (SPEC §8).
 *
 * Evasions repeat heavily — the same mangled number gets pasted into dozens of
 * conversations — so a cache hit is both free and instant. Key is a hash of
 * the FOLDED text, not the raw text: "call me on 9876543210" and
 * "Call me on ９８７６５４３２１０" are the same adjudication.
 *
 * DPDP note (SPEC §12.12): the cache stores a HASH, never the message text.
 */

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export interface AdjudicationCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
}

/**
 * LRU cache, 50k entries by default (SPEC §8).
 *
 * Uses Map insertion order for recency: re-inserting on read moves an entry to
 * the newest position, so the oldest key is always the first one Map yields.
 */
export class LruCache<T> implements AdjudicationCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly maxEntries = 50_000,
    /** Optional TTL; omit for no expiry. */
    private readonly ttlMs?: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount++;
      return undefined;
    }

    if (this.ttlMs !== undefined && this.clock() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.missCount++;
      return undefined;
    }

    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.clock() });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  clear(): void {
    this.entries.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}

/**
 * SHA-256-style cache key over the folded text.
 *
 * core has no crypto dependency and must run in the browser, so this uses a
 * 128-bit FNV-1a-based digest rather than real SHA-256. It is a CACHE KEY, not
 * a security primitive: collisions cost a wrong cache hit, so the width is
 * chosen to make that vanishingly unlikely, and nothing here is used for
 * authentication. The server may substitute a real sha256 via `hashFn`.
 */
export function cacheKey(foldedText: string): string {
  const normalized = foldedText.trim().replace(/\s+/g, " ");

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (code + i), 0xc2b2ae35) >>> 0;
    h4 = (Math.imul(h4 ^ code, 0x27d4eb2f) + h1) >>> 0;
  }

  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}
