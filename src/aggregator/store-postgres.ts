import type { AggregatorStats, AggregatorStore, IndexedJob } from './store.js'

/**
 * PostgreSQL AggregatorStore — the production system of record (PLAN.md Phase 5).
 *
 * STUB: deliberately unimplemented. The SQLite adapter (store-sqlite.ts) is the
 * working default and all aggregator logic, gossip, DHT, and tests run against
 * it offline. Fill this in when Postgres infra lands — wire up `pg`, mirror the
 * `indexed_jobs` schema (content_hash PK, enrichment JSONB, salary_is_null,
 * platform_id index), and keep `upsert` idempotent by content hash.
 *
 * Connect via `DATABASE_URL`. See AGENT_README "Phase 5".
 */
export interface PostgresStoreOptions {
  connectionString: string
}

const NOT_IMPLEMENTED = 'PostgresAggregatorStore is a stub; use SqliteAggregatorStore until PG infra lands.'

export class PostgresAggregatorStore implements AggregatorStore {
  constructor(_options: PostgresStoreOptions) {
    throw new Error(NOT_IMPLEMENTED)
  }
  upsert(_indexed: IndexedJob): 'inserted' | 'updated' {
    throw new Error(NOT_IMPLEMENTED)
  }
  get(_contentHash: string): IndexedJob | undefined {
    throw new Error(NOT_IMPLEMENTED)
  }
  has(_contentHash: string): boolean {
    throw new Error(NOT_IMPLEMENTED)
  }
  allHashes(): string[] {
    throw new Error(NOT_IMPLEMENTED)
  }
  stats(): AggregatorStats {
    throw new Error(NOT_IMPLEMENTED)
  }
  count(): number {
    throw new Error(NOT_IMPLEMENTED)
  }
  close(): void {
    throw new Error(NOT_IMPLEMENTED)
  }
}
