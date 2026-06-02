import type { IndexedJob } from './store.js'
import type { SearchHit, SearchIndex, SearchQuery } from './search.js'

/**
 * MeiliSearch SearchIndex — the production search backend (PLAN.md Phase 5).
 *
 * STUB: deliberately unimplemented. The SQLite FTS5 adapter (search-sqlite.ts)
 * is the working default. Fill this in when Meili infra lands — wire up the
 * `meilisearch` JS client, use content_hash as the document primary key, index
 * title/company/description with platform_id as a filterable attribute, and map
 * Meili's ranking score into SearchHit.score (higher = better).
 *
 * Connect via `MEILI_HOST` / `MEILI_API_KEY`. See AGENT_README "Phase 5".
 */
export interface MeiliSearchOptions {
  host: string
  apiKey?: string
  indexName?: string
}

const NOT_IMPLEMENTED = 'MeiliSearchIndex is a stub; use SqliteSearchIndex until Meili infra lands.'

export class MeiliSearchIndex implements SearchIndex {
  constructor(_options: MeiliSearchOptions) {
    throw new Error(NOT_IMPLEMENTED)
  }
  index(_indexed: IndexedJob): void {
    throw new Error(NOT_IMPLEMENTED)
  }
  remove(_contentHash: string): void {
    throw new Error(NOT_IMPLEMENTED)
  }
  search(_query: SearchQuery): SearchHit[] {
    throw new Error(NOT_IMPLEMENTED)
  }
  count(): number {
    throw new Error(NOT_IMPLEMENTED)
  }
  close(): void {
    throw new Error(NOT_IMPLEMENTED)
  }
}
