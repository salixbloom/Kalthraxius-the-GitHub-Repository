import { subscribeToJobs } from '../gossip.js'
import { enrichJob } from '../enrichment/enrich.js'
import { loadPlatforms } from '../platforms.js'
import { announceAggregator } from './announce.js'
import { BloomFilter } from './bloom.js'
import { publishBloom } from './bloom-gossip.js'
import { queryLocal } from '../query/local.js'
import { provideAggregator } from '../query/discovery.js'
import { registerQueryHandler } from '../query/protocol.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { RawJob } from '../types.js'
import type { AggregatorStore } from './store.js'
import type { SearchIndex } from './search.js'
import type { QueryProfile, ScoredHit } from '../query/types.js'

export interface AggregatorNodeOptions {
  node: KalthraxiusNode
  store: AggregatorStore
  search: SearchIndex
  /** Platform ids to subscribe to. Defaults to the static registry. */
  platforms?: string[]
  /** How often to publish the DHT announcement + bloom broadcast (ms). Default 30s. */
  announceIntervalMs?: number
  /** Target false-positive rate for the broadcast bloom filter. Default 0.01. */
  bloomFpRate?: number
}

/**
 * The aggregator node (PLAN.md Phase 5). It is the indexing/serving member of
 * the network:
 *   - subscribes to every per-platform job topic and ingests gossiped jobs,
 *   - enriches each job on ingest (Phase 4 pipeline), persists it to the store,
 *     and indexes it for search — all deduped by content hash,
 *   - periodically announces `role:aggregator` + self-reported stats to the DHT
 *     and broadcasts a bloom filter of its held hashes.
 *
 * Restart safety: the store/index are persistent (e.g. SQLite files), so a
 * restarted aggregator recovers all prior jobs and simply re-subscribes — no
 * data loss. Re-ingesting a job already held is an idempotent upsert.
 */
export class AggregatorNode {
  private node: KalthraxiusNode
  private store: AggregatorStore
  private search: SearchIndex
  private platforms: string[]
  private announceIntervalMs: number
  private bloomFpRate: number

  private unsubscribers: Array<() => void> = []
  private announceTimer: NodeJS.Timeout | null = null
  private unregisterQuery: (() => Promise<void>) | null = null
  private started = false

  constructor(opts: AggregatorNodeOptions) {
    this.node = opts.node
    this.store = opts.store
    this.search = opts.search
    this.platforms = opts.platforms ?? loadPlatforms()
    this.announceIntervalMs = opts.announceIntervalMs ?? 30_000
    this.bloomFpRate = opts.bloomFpRate ?? 0.01
  }

  /** Subscribe to all platform topics and begin periodic announcing. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    for (const platformId of this.platforms) {
      const unsub = subscribeToJobs(this.node.services.pubsub, platformId, job =>
        this.ingest(job),
      )
      this.unsubscribers.push(unsub)
    }

    // Serve queries: register the request/response handler so clients can fan
    // out to us, and provide the rendezvous CID so they can discover us.
    this.unregisterQuery = await registerQueryHandler(this.node, profile => this.query(profile))
    await provideAggregator(this.node.services.dht).catch(() => {})

    // Announce once immediately so the node is discoverable without waiting a
    // full interval, then on a timer.
    await this.announce().catch(() => {})
    this.announceTimer = setInterval(() => {
      void this.announce().catch(() => {})
    }, this.announceIntervalMs)
    // Don't let the announce timer keep the process alive on its own.
    this.announceTimer.unref?.()
  }

  /**
   * Ingest a single raw job: enrich, persist, index. Idempotent by content
   * hash — gossip delivers the same job from multiple scrapers, and this
   * collapses them to one stored record. Exposed (not just used by the
   * subscription) so callers/tests can feed jobs directly.
   */
  ingest(job: RawJob): 'inserted' | 'updated' {
    const enrichment = enrichJob(job)
    const result = this.store.upsert({ job, enrichment })
    this.search.index({ job, enrichment })
    return result
  }

  /** Publish the DHT announcement and bloom broadcast reflecting current state. */
  async announce(): Promise<void> {
    const peerId = this.node.peerId.toString()
    const stats = this.store.stats()
    await announceAggregator(this.node.services.dht, peerId, stats)
    // Refresh the rendezvous provider record so discovery stays live.
    await provideAggregator(this.node.services.dht).catch(() => {})

    const filter = BloomFilter.fromHashes(this.store.allHashes(), this.bloomFpRate)
    await publishBloom(this.node.services.pubsub, peerId, filter)
  }

  stats() {
    return this.store.stats()
  }

  /** Run a query against this aggregator's local store (filter → score → rank). */
  query(profile: QueryProfile): ScoredHit[] {
    return queryLocal(this.store, profile)
  }

  /** Stop subscriptions and the announce timer. Does not close store/search. */
  async stop(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    if (this.unregisterQuery) {
      await this.unregisterQuery().catch(() => {})
      this.unregisterQuery = null
    }
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []
    this.started = false
  }
}
