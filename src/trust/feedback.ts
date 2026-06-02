import type { PubSub, Message } from '@libp2p/interface'

/**
 * User-feedback gossip (PLAN.md Phase 7: "lightweight `{ jobId, reason }`
 * signals gossip through the network and accumulate per-aggregator"). When a
 * user flags a job (expired, spam, mislabelled, …), the client broadcasts a
 * small signal on a global topic. Aggregators and clients subscribe and
 * accumulate it per-aggregator, feeding the feedback term of reputation.
 *
 * One global topic; signals are tiny JSON. The `servedBy` field attributes the
 * signal to the aggregator that served the job, so accumulation is per-peer.
 */
export const FEEDBACK_TOPIC = '/kalthraxius/feedback/v1'

export type FeedbackReason = 'expired' | 'spam' | 'mislabeled' | 'duplicate' | 'other'

export interface FeedbackSignal {
  /** content hash of the job being flagged. */
  jobId: string
  reason: FeedbackReason
  /** peerId of the aggregator that served the job (attribution). */
  servedBy: string
  /** Unix ms. */
  at: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function publishFeedback(pubsub: PubSub, signal: FeedbackSignal): Promise<void> {
  await pubsub.publish(FEEDBACK_TOPIC, enc.encode(JSON.stringify(signal)))
}

export function subscribeToFeedback(
  pubsub: PubSub,
  handler: (signal: FeedbackSignal) => void,
): () => void {
  pubsub.subscribe(FEEDBACK_TOPIC)
  const listener = (event: CustomEvent<Message>) => {
    if (event.detail.topic !== FEEDBACK_TOPIC) return
    try {
      handler(JSON.parse(dec.decode(event.detail.data)) as FeedbackSignal)
    } catch {
      // malformed — drop
    }
  }
  pubsub.addEventListener('message', listener as EventListener)
  return () => {
    pubsub.removeEventListener('message', listener as EventListener)
    try {
      pubsub.unsubscribe(FEEDBACK_TOPIC)
    } catch {
      // pubsub already stopped — nothing to unsubscribe
    }
  }
}

/**
 * Per-aggregator feedback accumulator. Negative signals (any reason) drive the
 * feedback health DOWN. Deduplicated by (jobId, servedBy, reason) so one user
 * spamming the same flag can't dominate — each distinct complaint counts once.
 */
export class FeedbackLedger {
  private byPeer = new Map<string, Set<string>>()

  record(signal: FeedbackSignal): void {
    const set = this.byPeer.get(signal.servedBy) ?? new Set<string>()
    set.add(`${signal.jobId}:${signal.reason}`)
    this.byPeer.set(signal.servedBy, set)
  }

  /** Distinct negative signals accumulated against an aggregator. */
  negativeCount(peerId: string): number {
    return this.byPeer.get(peerId)?.size ?? 0
  }

  /**
   * Feedback health in [0, 1] for reputation. Starts at 1.0 and decays with the
   * count of distinct complaints, saturating toward 0. `scale` is the count at
   * which health reaches 0.5.
   */
  feedbackScore(peerId: string, scale = 10): number {
    const n = this.negativeCount(peerId)
    return scale / (scale + n)
  }
}
