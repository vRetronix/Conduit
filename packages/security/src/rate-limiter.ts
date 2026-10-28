export interface FailureLimiterOptions {
  /** Failures allowed within the window before further attempts are blocked. */
  maxFailures: number;
  windowMs: number;
  /** Upper bound on tracked keys; the oldest are evicted first. */
  maxKeys?: number;
  now?: () => number;
}

export type LimitCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Sliding-window failure counter. Attempts for a key are blocked once it has `maxFailures` failures in the
 * last `windowMs`; they unblock as old failures age out. In-memory by design: the server is single-process
 * and local-only. A restart clears it, which is documented.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: FailureLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  check(key: string): LimitCheck {
    const list = this.recent(key);
    if (list.length < this.options.maxFailures) return { allowed: true };
    const oldestRelevant = list[list.length - this.options.maxFailures]!;
    return { allowed: false, retryAfterMs: Math.max(1, oldestRelevant + this.options.windowMs - this.now()) };
  }

  /** Records a failure now, or at `atMs` when restoring history (e.g. after a restart). */
  recordFailure(key: string, atMs: number = this.now()): void {
    const list = this.recent(key);
    if (atMs <= this.now() - this.options.windowMs) return; // already outside the window
    list.push(atMs);
    list.sort((a, b) => a - b);
    this.failures.delete(key); // re-insert so Map order tracks recency for eviction
    this.failures.set(key, list.slice(-this.options.maxFailures));
    const maxKeys = this.options.maxKeys ?? 10_000;
    while (this.failures.size > maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
