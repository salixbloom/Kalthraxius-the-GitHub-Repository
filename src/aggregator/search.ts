import type { IndexedJob } from './store.js'

export interface SearchQuery {
  /** Free-text query over title / company / description. */
  text: string
  /** Optional platform filter. */
  platformId?: string
  limit?: number
}

export interface SearchHit {
  contentHash: string
  score: number
}

/**
 * Full-text search index over indexed jobs. SQLite FTS5 is the default adapter;
 * MeiliSearch is the production adapter. Kept separate from AggregatorStore so
 * the search backend can be swapped independently of the system of record — the
 * store is authoritative, the index is derived and rebuildable.
 */
export interface SearchIndex {
  /** Index (or re-index) a job. Idempotent by content hash. */
  index(indexed: IndexedJob): void
  /** Remove a job from the index. */
  remove(contentHash: string): void
  search(query: SearchQuery): SearchHit[]
  count(): number
  close(): void
}
