import type { AggregatorAnnouncement } from '../aggregator/announce.js'
import type { AggregatorStats } from '../aggregator/store.js'

/**
 * Cross-aggregator stat consistency (PLAN.md Phase 7: "compare self-reported
 * stats visible in DHT announcements"). Aggregators announce coverage stats; an
 * outlier whose numbers diverge wildly from the consensus is suspicious (either
 * broken or lying). This yields a per-aggregator consistency score in [0, 1]
 * that feeds reputation.
 *
 * Note this is a SOFT signal: aggregators legitimately differ in coverage, so a
 * lone aggregator covering a niche platform shouldn't be condemned. We compare
 * on a normalised, scale-free basis (the salary null-rate, a quality ratio that
 * honest aggregators should roughly agree on) rather than raw totals, which
 * legitimately vary.
 */

export interface ConsistencyReport {
  peerId: string
  consistency: number
  /** The metric we compared and the consensus we compared against. */
  salaryNullRate: number
  consensusNullRate: number
}

/**
 * Score each announcement's consistency against the consensus of the set.
 * The consensus is the MEDIAN salary null-rate (robust to outliers — a single
 * liar can't drag it). Consistency = 1 - |self - median|, so an aggregator
 * matching the median scores 1.0 and one reporting a wildly different quality
 * ratio scores lower.
 *
 * With fewer than 3 aggregators there's no meaningful consensus, so everyone
 * gets a neutral 1.0 (don't penalise on thin evidence).
 */
export function scoreConsistency(announcements: AggregatorAnnouncement[]): ConsistencyReport[] {
  const rates = announcements.map(a => a.stats.salaryNullRate)
  const consensus = median(rates)

  return announcements.map(a => {
    const rate = a.stats.salaryNullRate
    const consistency =
      announcements.length < 3 ? 1 : clamp01(1 - Math.abs(rate - consensus))
    return {
      peerId: a.peerId,
      consistency,
      salaryNullRate: rate,
      consensusNullRate: consensus,
    }
  })
}

/**
 * Detect a direct content disagreement: two announcements that claim the same
 * coverage footprint but report contradictory quality. Used as a sharper,
 * pairwise tamper hint than the population score. Returns peers whose null-rate
 * deviates from consensus by more than `threshold`.
 */
export function flagOutliers(
  announcements: AggregatorAnnouncement[],
  threshold = 0.4,
): string[] {
  if (announcements.length < 3) return []
  const consensus = median(announcements.map(a => a.stats.salaryNullRate))
  return announcements
    .filter(a => Math.abs(a.stats.salaryNullRate - consensus) > threshold)
    .map(a => a.peerId)
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

export type { AggregatorStats }
