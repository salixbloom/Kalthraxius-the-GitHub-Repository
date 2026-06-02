import { ENRICHMENT_SCHEMA_VERSION } from '../types.js'
import { EnrichmentStore } from '../enrichment-store.js'
import { enrichJob } from './enrich.js'
import type Database from 'better-sqlite3'

export interface WorkerOptions {
  /** Jobs to pull and enrich per batch. Default 100. */
  batchSize?: number
  /** Ms to wait before re-polling when the queue is empty. Default 1000. */
  idlePollMs?: number
  /** Enrichment schema version to target. Defaults to the current constant. */
  schemaVersion?: number
  /** Called after each batch with how many were processed (for instrumentation). */
  onBatch?: (count: number) => void
}

/**
 * Async, decoupled enrichment worker. Polls the store for jobs whose
 * enrichment is missing or stale (`schema_version < current`), enriches them in
 * CPU-bound batches, and writes results to the `enrichments` table.
 *
 * Decoupling guarantees:
 *   - It never touches the ingest path; it only reads `jobs` and writes
 *     `enrichments`. Ingest (`JobCache.upsert`) is unaffected whether the worker
 *     runs or not.
 *   - Between batches it yields to the event loop (`setImmediate`), so a long
 *     backlog can't starve ingest, gossip, or DHT work on the same thread.
 *   - Each batch's writes are wrapped in a single transaction for throughput.
 *
 * A schema-version bump (ENRICHMENT_SCHEMA_VERSION in types.ts) automatically
 * re-queues every record — the worker is the migration mechanism.
 */
export class EnrichmentWorker {
  private store: EnrichmentStore
  private db: Database.Database
  private batchSize: number
  private idlePollMs: number
  private schemaVersion: number
  private onBatch?: (count: number) => void

  private running = false
  private stopRequested = false
  private idleTimer: NodeJS.Timeout | null = null
  private wakeIdle: (() => void) | null = null
  private loopPromise: Promise<void> | null = null

  constructor(db: Database.Database, opts: WorkerOptions = {}) {
    this.db = db
    this.store = new EnrichmentStore(db)
    this.batchSize = opts.batchSize ?? 100
    this.idlePollMs = opts.idlePollMs ?? 1000
    this.schemaVersion = opts.schemaVersion ?? ENRICHMENT_SCHEMA_VERSION
    this.onBatch = opts.onBatch
  }

  /**
   * Process exactly one batch synchronously and return how many jobs were
   * enriched (0 if the queue is empty). Exposed for tests and for callers that
   * want to drive enrichment manually rather than via the polling loop.
   */
  processBatch(): number {
    const jobs = this.store.pendingJobs(this.batchSize, this.schemaVersion)
    if (jobs.length === 0) return 0

    const writeAll = this.db.transaction(() => {
      for (const job of jobs) {
        this.store.put(enrichJob(job))
      }
    })
    writeAll()

    this.onBatch?.(jobs.length)
    return jobs.length
  }

  /** Drain the entire backlog synchronously. Returns total jobs enriched. */
  drain(): number {
    let total = 0
    let n: number
    do {
      n = this.processBatch()
      total += n
    } while (n > 0)
    return total
  }

  /** Start the background polling loop. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.stopRequested = false
    this.loopPromise = this.loop()
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      const processed = this.processBatch()
      if (this.stopRequested) break
      if (processed === 0) {
        // Queue empty — wait before re-polling, but stay interruptible: stop()
        // can wake this immediately by calling wakeIdle() (otherwise clearing
        // the timer alone would leave this promise pending forever).
        await new Promise<void>(resolve => {
          this.wakeIdle = resolve
          this.idleTimer = setTimeout(resolve, this.idlePollMs)
        })
        this.idleTimer = null
        this.wakeIdle = null
      } else {
        // More work likely pending — yield to the event loop so ingest/gossip
        // get a turn, then continue immediately.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    this.running = false
  }

  /** Stop the polling loop and wait for the current batch to settle. */
  async stop(): Promise<void> {
    this.stopRequested = true
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    // Resolve any in-flight idle wait so the loop can observe stopRequested and
    // exit, instead of hanging on a promise whose timer we just cleared.
    if (this.wakeIdle) {
      this.wakeIdle()
      this.wakeIdle = null
    }
    if (this.loopPromise) await this.loopPromise
    this.loopPromise = null
  }

  pendingCount(): number {
    return this.store.pendingCount(this.schemaVersion)
  }
}
