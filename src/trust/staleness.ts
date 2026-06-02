import type { AggregatorStore } from '../aggregator/store.js'

/**
 * Staleness probe (PLAN.md Phase 7: "aggregator periodically re-fetches N random
 * old job URLs and reports staleness rate"). An aggregator self-samples old
 * postings, re-checks whether their URLs are still live, and reports the dead
 * rate. A high rate means the index is full of expired listings — a quality
 * signal clients fold into reputation.
 *
 * Fetching is INJECTED (`URLChecker`) so the probe is fully testable offline:
 * production wires it to the real fetcher (HTTP HEAD/GET; 404/410/connection
 * failure → 'dead'); tests inject a deterministic stub.
 */

export type UrlStatus = 'alive' | 'dead'
export type URLChecker = (url: string) => Promise<UrlStatus>

export interface StalenessOptions {
  /** Number of old jobs to sample. Default 50. */
  sampleSize?: number
  /**
   * Only sample jobs at least this old (ms). Fresh jobs aren't expected to be
   * dead, so probing them is noise. Default 7 days.
   */
  minAgeMs?: number
  /** Bounded concurrency for the URL checks. Default 8. */
  concurrency?: number
}

export interface StalenessReport {
  sampled: number
  dead: number
  /** dead / sampled, or 0 when nothing was sampled. */
  stalenessRate: number
  deadUrls: string[]
}

/**
 * Sample old jobs from the store and re-check their URLs. Returns the measured
 * staleness rate. Best-effort: a checker that throws on a URL counts that URL
 * as indeterminate and skips it (neither alive nor dead) so a flaky check
 * doesn't inflate the rate.
 */
export async function probeStaleness(
  store: AggregatorStore,
  check: URLChecker,
  opts: StalenessOptions = {},
): Promise<StalenessReport> {
  const sampleSize = opts.sampleSize ?? 50
  const minAgeMs = opts.minAgeMs ?? 7 * 24 * 60 * 60 * 1000
  const concurrency = opts.concurrency ?? 8
  const cutoff = Date.now() - minAgeMs

  // `all()` returns newest-first; old jobs are at the tail. Pull a generous
  // window and filter by age, then take the sample.
  const candidates = store
    .all()
    .filter(j => j.job.scrapedAt <= cutoff)
    .slice(-Math.max(sampleSize * 4, sampleSize))

  const sample = pickRandom(candidates, sampleSize)
  const deadUrls: string[] = []
  let sampled = 0

  // Bounded-concurrency worker pool over the sample.
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < sample.length) {
      const job = sample[cursor++]!
      try {
        const status = await check(job.job.url)
        sampled++
        if (status === 'dead') deadUrls.push(job.job.url)
      } catch {
        // indeterminate — don't count toward sampled or dead
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, worker))

  return {
    sampled,
    dead: deadUrls.length,
    stalenessRate: sampled === 0 ? 0 : deadUrls.length / sampled,
    deadUrls,
  }
}

function pickRandom<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items]
  // Partial Fisher–Yates.
  const arr = [...items]
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr.slice(0, n)
}
