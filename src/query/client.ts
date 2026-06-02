import { findAggregators } from './discovery.js'
import { queryPeer } from './protocol.js'
import { runQuery } from './engine.js'
import type { PeerId, PeerInfo } from '@libp2p/interface'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { QueryProfile, ScoredHit } from './types.js'

export interface FanOutOptions {
  /** Number of peers to fan out to. Default 6 (PLAN.md K=6). */
  k?: number
  /** Per-peer query timeout (ms). Default 5000. */
  peerTimeoutMs?: number
  /** Explicit peers to query, bypassing DHT discovery (tests / known set). */
  peers?: Array<PeerId | PeerInfo>
}

export interface FanOutResult {
  hits: ScoredHit[]
  /** Peers that answered successfully. */
  answered: string[]
  /** Peers that failed (dial/timeout/protocol) — drove failover. */
  failed: string[]
}

/**
 * Fan-out query client (PLAN.md Phase 6). Discovers aggregators via the DHT
 * rendezvous, queries up to K in parallel, dedups results by content hash, and
 * merges them into a single ranked list.
 *
 * Failover is implicit: a peer that throws (dial/timeout/protocol) is recorded
 * in `failed` and simply doesn't contribute — the merge proceeds with whoever
 * answered. `queryStream` additionally tops up from spare discovered peers when
 * some of the first K fail, so a dead primary doesn't shrink the result set.
 */
export class QueryClient {
  private node: KalthraxiusNode

  constructor(node: KalthraxiusNode) {
    this.node = node
  }

  /** Resolve the candidate peer set: explicit peers, else DHT discovery. */
  private async discover(opts: FanOutOptions): Promise<Array<PeerId | PeerInfo>> {
    if (opts.peers?.length) return opts.peers
    return findAggregators(this.node.services.dht, {
      self: this.node.peerId,
      max: Math.max((opts.k ?? 6) * 3, 12),
    })
  }

  /**
   * One-shot fan-out: query K peers, merge, return the ranked result. Used by
   * the REST endpoint. For streaming first-results-fast, see `queryStream`.
   */
  async query(profile: QueryProfile, opts: FanOutOptions = {}): Promise<FanOutResult> {
    const k = opts.k ?? 6
    const peers = (await this.discover(opts)).slice(0, k)
    const answered: string[] = []
    const failed: string[] = []
    const merged = new Map<string, ScoredHit>()

    await Promise.all(
      peers.map(async peer => {
        const id = peerKey(peer)
        try {
          const hits = await queryPeer(this.node, peerAddr(peer), profile, opts.peerTimeoutMs)
          answered.push(id)
          for (const hit of hits) dedup(merged, hit)
        } catch {
          failed.push(id)
        }
      }),
    )

    return { hits: rankMerged(merged, profile), answered, failed }
  }

  /**
   * Streaming fan-out: yields hits as each peer responds (first results arrive
   * as soon as the fastest aggregator answers — the basis for SSE <200ms), with
   * failover top-up from spare peers. Emits each unique content hash at most
   * once. A final re-rank is the caller's job if it wants global ordering.
   */
  async *queryStream(
    profile: QueryProfile,
    opts: FanOutOptions = {},
  ): AsyncGenerator<ScoredHit, FanOutResult> {
    const k = opts.k ?? 6
    const all = await this.discover(opts)
    const primary = all.slice(0, k)
    const spares = all.slice(k)

    const answered: string[] = []
    const failed: string[] = []
    const emitted = new Set<string>()
    const merged = new Map<string, ScoredHit>()

    // Pushable queue so we can yield results in arrival order across peers.
    const queue: ScoredHit[] = []
    let resolveWake: (() => void) | null = null
    const wake = () => {
      resolveWake?.()
      resolveWake = null
    }

    let active = 0
    const startPeer = (peer: PeerId | PeerInfo): Promise<void> => {
      active++
      const id = peerKey(peer)
      return queryPeer(this.node, peerAddr(peer), profile, opts.peerTimeoutMs)
        .then(hits => {
          answered.push(id)
          for (const hit of hits) {
            dedup(merged, hit)
            if (!emitted.has(hit.contentHash)) {
              emitted.add(hit.contentHash)
              queue.push(hit)
            }
          }
        })
        .catch(() => {
          failed.push(id)
          // Failover: pull in a spare to replace the failed peer.
          const spare = spares.shift()
          if (spare) return startPeer(spare)
        })
        .finally(() => {
          active--
          wake()
        })
    }

    const running = primary.map(startPeer)
    void Promise.allSettled(running)

    while (active > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>(resolve => {
          resolveWake = resolve
        })
        continue
      }
      yield queue.shift()!
    }

    return { hits: rankMerged(merged, profile), answered, failed }
  }
}

/** Keep the higher-scoring copy of a duplicate content hash. */
function dedup(merged: Map<string, ScoredHit>, hit: ScoredHit): void {
  const existing = merged.get(hit.contentHash)
  if (!existing || hit.score > existing.score) merged.set(hit.contentHash, hit)
}

/**
 * Re-rank the merged set. Aggregators already filter+score, but each ranked
 * only its own slice; re-running the ranking comparator over the union gives a
 * single global order. We re-sort by the scores the peers returned (trusting
 * their engine ran the same pipeline) rather than re-deriving, since we don't
 * hold every job's full record here — `runQuery` is used client-side only when
 * the caller has full IndexedJobs.
 */
function rankMerged(merged: Map<string, ScoredHit>, profile: QueryProfile): ScoredHit[] {
  const hits = [...merged.values()].sort(
    (a, b) => b.score - a.score || a.contentHash.localeCompare(b.contentHash),
  )
  const limit = profile.limit ?? 50
  return hits.slice(0, limit)
}

function peerKey(peer: PeerId | PeerInfo): string {
  return 'id' in peer ? peer.id.toString() : peer.toString()
}

function peerAddr(peer: PeerId | PeerInfo): PeerId | import('@multiformats/multiaddr').Multiaddr[] {
  // A PeerInfo carries multiaddrs (dialable directly); a bare PeerId relies on
  // the peerstore / DHT to resolve addresses at dial time.
  if ('id' in peer) {
    return peer.multiaddrs?.length ? peer.multiaddrs : peer.id
  }
  return peer
}

export { runQuery }
