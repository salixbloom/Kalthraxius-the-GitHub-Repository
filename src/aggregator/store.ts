import type { Enrichment, RawJob } from '../types.js'

/** A raw job plus its enrichment, as the aggregator stores and serves it. */
export interface IndexedJob {
  job: RawJob
  enrichment: Enrichment
}

/** Self-reported coverage stats the aggregator announces over the DHT. */
export interface AggregatorStats {
  /** Total distinct jobs held (by content hash). */
  totalJobs: number
  /** Per-platform job counts. */
  byPlatform: Record<string, number>
  /** Fraction of jobs whose salary could not be extracted (0–1). */
  salaryNullRate: number
  /** Unix ms of the most recently ingested job, or 0 if empty. */
  newestScrapedAt: number
}

/**
 * Persistent storage for an aggregator node. The SQLite/FTS5 adapter is the
 * working default (in-process, offline-testable); PostgreSQL is a drop-in
 * adapter for production. Both implement this contract so the aggregator node
 * is storage-agnostic.
 *
 * Dedup contract: `upsert` is keyed by `job.contentHash` and is idempotent —
 * re-ingesting the same hash is a no-op-or-update, never a duplicate. This is
 * what makes gossip (which delivers the same job from multiple scrapers) safe.
 */
export interface AggregatorStore {
  /** Insert or update by content hash. Returns whether the row was new. */
  upsert(indexed: IndexedJob): 'inserted' | 'updated'
  get(contentHash: string): IndexedJob | undefined
  has(contentHash: string): boolean
  /** All content hashes currently held (drives the bloom filter). */
  allHashes(): string[]
  stats(): AggregatorStats
  count(): number
  close(): void
}
