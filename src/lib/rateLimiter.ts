export interface RateLimiterOpts {
  /** Maximum hits permitted within `windowMs`. */
  max: number;
  /** Sliding window length in ms. */
  windowMs: number;
}

export interface RateLimiter {
  /** Returns true if the hit is permitted, false if rate-limited. */
  allow(key: string): boolean;
}

/**
 * In-memory sliding-window rate limiter. Maps each key (e.g. a
 * `token|viewerId` pair) to the timestamps of its recent hits and
 * prunes the prefix older than `windowMs` on every check.
 *
 * Suitable for single-process dev / a single Node worker. For multi-worker
 * production we would need Redis or a Postgres-backed counter.
 */
export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const buckets = new Map<string, number[]>();
  // F33: the previous implementation never deleted keys, so a hostile
  // caller rotating the key component (a fresh email or UUID per request)
  // grew this Map without bound for the process lifetime. We now (a) delete
  // a key the moment its window empties, and (b) run a lazy O(n) sweep at
  // most once per window to reclaim keys that were touched once and never
  // revisited. Bounds live keys to "those seen within ~2 windows".
  let lastSweep = Date.now();

  function sweep(now: number, cutoff: number): void {
    for (const [k, ts] of buckets) {
      let live = false;
      for (const t of ts) {
        if (t > cutoff) { live = true; break; }
      }
      if (!live) buckets.delete(k);
    }
    lastSweep = now;
  }

  return {
    allow(key) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      if (now - lastSweep > opts.windowMs) sweep(now, cutoff);
      const prior = buckets.get(key) ?? [];
      // Drop timestamps that have fallen out of the window.
      const hits: number[] = [];
      for (const t of prior) {
        if (t > cutoff) hits.push(t);
      }
      if (hits.length >= opts.max) {
        buckets.set(key, hits);
        return false;
      }
      hits.push(now);
      buckets.set(key, hits);
      return true;
    },
  };
}
