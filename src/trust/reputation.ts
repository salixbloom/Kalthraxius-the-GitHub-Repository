/**
 * Client-side reputation scoring for aggregators (PLAN.md Phase 7).
 *
 * The score is a weighted blend of four signals, with content-hash INTEGRITY
 * weighted highest because it is the only TAMPER-PROOF signal (risk register:
 * "Content-hash verification is the only tamper-proof signal. Weight it highest
 * in reputation score."). The other three (staleness, stat consistency, user
 * feedback) are self-reported or indirect and so are individually gameable;
 * they refine, they don't dominate.
 *
 * All inputs are normalised to [0, 1]; the output is [0, 1] (higher = more
 * trustworthy). A client uses it to prefer aggregators and to weight or discard
 * their results.
 */

export interface ReputationSignals {
  /**
   * Fraction of received jobs from this aggregator whose content hash verified.
   * 1.0 = every job's content matched its hash; <1.0 = saw fabricated/tampered
   * content. The dominant signal.
   */
  integrityPassRate: number
  /**
   * The aggregator's reported (or probed) staleness rate — fraction of sampled
   * old job URLs found dead. Lower is better, so we use (1 - staleness).
   */
  stalenessRate: number
  /**
   * How consistent this aggregator's self-reported DHT stats are with the
   * cross-aggregator consensus (1.0 = in line with peers, 0 = wildly off).
   */
  statConsistency: number
  /**
   * Accumulated user-feedback health in [0, 1] (1.0 = no negative feedback,
   * decaying as negative `{jobId, reason}` signals accrue).
   */
  feedbackScore: number
}

export interface ReputationWeights {
  integrity: number
  staleness: number
  consistency: number
  feedback: number
}

/** Integrity-dominant defaults (sum to 1). */
export const DEFAULT_WEIGHTS: ReputationWeights = {
  integrity: 0.5,
  staleness: 0.2,
  consistency: 0.2,
  feedback: 0.1,
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Compute a reputation score in [0, 1]. Missing signals default to neutral-ish
 * values so a freshly-seen aggregator isn't unfairly punished before evidence
 * accumulates — except integrity, which defaults to 1 only because "no
 * mismatches seen yet" is the honest prior (it drops fast on the first failure
 * given its weight).
 */
export function reputationScore(
  signals: Partial<ReputationSignals>,
  weights: ReputationWeights = DEFAULT_WEIGHTS,
): number {
  const integrity = clamp01(signals.integrityPassRate ?? 1)
  const freshness = 1 - clamp01(signals.stalenessRate ?? 0)
  const consistency = clamp01(signals.statConsistency ?? 1)
  const feedback = clamp01(signals.feedbackScore ?? 1)

  const total = weights.integrity + weights.staleness + weights.consistency + weights.feedback
  const raw =
    weights.integrity * integrity +
    weights.staleness * freshness +
    weights.consistency * consistency +
    weights.feedback * feedback

  return clamp01(raw / total)
}

/**
 * Running per-aggregator reputation tracker a client maintains across a session.
 * Accumulates integrity observations and feedback as they arrive, and folds in
 * staleness / consistency snapshots, exposing a live `score(peerId)`.
 */
export class ReputationTracker {
  private weights: ReputationWeights
  private integrity = new Map<string, { pass: number; total: number }>()
  private staleness = new Map<string, number>()
  private consistency = new Map<string, number>()
  private feedback = new Map<string, { negative: number; total: number }>()

  constructor(weights: ReputationWeights = DEFAULT_WEIGHTS) {
    this.weights = weights
  }

  /** Record one integrity observation (a received job verified or not). */
  recordIntegrity(peerId: string, ok: boolean): void {
    const e = this.integrity.get(peerId) ?? { pass: 0, total: 0 }
    e.total++
    if (ok) e.pass++
    this.integrity.set(peerId, e)
  }

  /** Record one user feedback signal against a job served by this aggregator. */
  recordFeedback(peerId: string, negative: boolean): void {
    const e = this.feedback.get(peerId) ?? { negative: 0, total: 0 }
    e.total++
    if (negative) e.negative++
    this.feedback.set(peerId, e)
  }

  setStaleness(peerId: string, rate: number): void {
    this.staleness.set(peerId, clamp01(rate))
  }

  setConsistency(peerId: string, consistency: number): void {
    this.consistency.set(peerId, clamp01(consistency))
  }

  signals(peerId: string): Partial<ReputationSignals> {
    const integ = this.integrity.get(peerId)
    const fb = this.feedback.get(peerId)
    return {
      integrityPassRate: integ ? integ.pass / integ.total : undefined,
      stalenessRate: this.staleness.get(peerId),
      statConsistency: this.consistency.get(peerId),
      // feedbackScore = 1 - share of negative feedback.
      feedbackScore: fb ? 1 - fb.negative / fb.total : undefined,
    }
  }

  score(peerId: string): number {
    return reputationScore(this.signals(peerId), this.weights)
  }
}
