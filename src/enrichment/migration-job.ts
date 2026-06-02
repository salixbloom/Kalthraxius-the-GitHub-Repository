import { EnrichmentWorker } from './worker.js'
import { ENRICHMENT_SCHEMA_VERSION } from '../types.js'
import type Database from 'better-sqlite3'

/**
 * Background schema-migration job (PLAN.md Phase 8). When an extractor changes
 * and ENRICHMENT_SCHEMA_VERSION is bumped, every record with an older
 * `schema_version` must be re-enriched. The enrichment worker already does this
 * (`WHERE schema_version < CURRENT`); this wrapper drives it as a controlled,
 * BATCHED, observable migration with progress reporting and a pause between
 * batches so a large back-migration doesn't monopolise the node.
 *
 * Idempotent and resumable: each batch is its own transaction, so an
 * interrupted migration simply resumes from the remaining stale records on the
 * next run.
 */

export interface MigrationOptions {
  /** Records per batch. Default 200. */
  batchSize?: number
  /** Pause between batches (ms) to yield I/O / CPU. Default 0. */
  pauseMs?: number
  /** Target schema version. Defaults to the current constant. */
  schemaVersion?: number
  /** Progress callback after each batch: (migrated so far, total to migrate). */
  onProgress?: (migrated: number, total: number) => void
}

export interface MigrationReport {
  migrated: number
  fromPending: number
  schemaVersion: number
}

export async function runMigration(
  db: Database.Database,
  opts: MigrationOptions = {},
): Promise<MigrationReport> {
  const batchSize = opts.batchSize ?? 200
  const pauseMs = opts.pauseMs ?? 0
  const schemaVersion = opts.schemaVersion ?? ENRICHMENT_SCHEMA_VERSION

  const worker = new EnrichmentWorker(db, { batchSize, schemaVersion })
  const total = worker.pendingCount()

  let migrated = 0
  let n: number
  do {
    n = worker.processBatch()
    migrated += n
    if (n > 0) {
      opts.onProgress?.(migrated, total)
      if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs))
    }
  } while (n > 0)

  return { migrated, fromPending: total, schemaVersion }
}
