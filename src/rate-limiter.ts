/**
 * Per-key request rate limiter (enforces a platform descriptor's `rateLimit`).
 *
 * A scraper must not hammer a job board faster than its descriptor permits.
 * This limiter turns `requestsPerMinute` into a minimum interval between
 * acquisitions and `await`s until that interval has elapsed since the last
 * request for the same key. Keyed by platform id, so independent platforms
 * don't throttle each other, but every fetch against one platform is paced —
 * within a single pass (future pagination/multi-URL) and across passes.
 *
 * Serial by design: concurrent `acquire()` calls for the same key queue behind
 * one another, each spaced by the interval, so bursts can't slip through.
 */
export class RateLimiter {
  /** key → timestamp (ms) the next request is allowed at. */
  private nextAllowedAt = new Map<string, number>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    // Injectable clock/sleep so tests don't wait in real time.
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  }

  /**
   * Wait until a request is permitted for `key` at the given rate, then reserve
   * the slot. `requestsPerMinute <= 0` means "no limit" — returns immediately.
   */
  async acquire(key: string, requestsPerMinute: number): Promise<void> {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) return

    const intervalMs = 60_000 / requestsPerMinute
    const now = this.now()
    const earliest = this.nextAllowedAt.get(key) ?? 0
    const startAt = Math.max(now, earliest)
    const waitMs = startAt - now

    // Reserve the slot *before* sleeping so concurrent acquirers for the same
    // key serialize correctly (each reads the bumped nextAllowedAt).
    this.nextAllowedAt.set(key, startAt + intervalMs)

    if (waitMs > 0) await this.sleep(waitMs)
  }
}
