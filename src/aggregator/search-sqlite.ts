import Database from 'better-sqlite3'
import type { IndexedJob } from './store.js'
import type { SearchHit, SearchIndex, SearchQuery } from './search.js'

/**
 * Default SearchIndex backed by SQLite FTS5. The index is derived from the
 * store and fully rebuildable, so it can live in the same DB file as the store
 * or its own; the aggregator passes a separate path. MeiliSearch is the
 * production swap-in implementing the same interface.
 */
export class SqliteSearchIndex implements SearchIndex {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.init()
  }

  private init(): void {
    // External-content-free FTS5 table keyed by content_hash (UNINDEXED so we
    // can filter/return it without it polluting the match).
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS job_fts USING fts5(
        content_hash UNINDEXED,
        platform_id  UNINDEXED,
        title,
        company,
        description
      );
    `)
  }

  index(indexed: IndexedJob): void {
    const { job } = indexed
    // FTS5 has no UPSERT; delete-then-insert keeps it idempotent by hash.
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM job_fts WHERE content_hash = ?').run(job.contentHash)
      this.db
        .prepare(`
          INSERT INTO job_fts (content_hash, platform_id, title, company, description)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(job.contentHash, job.platformId, job.title, job.company, job.description)
    })
    tx()
  }

  remove(contentHash: string): void {
    this.db.prepare('DELETE FROM job_fts WHERE content_hash = ?').run(contentHash)
  }

  search(query: SearchQuery): SearchHit[] {
    const limit = query.limit ?? 50
    const match = toFtsMatch(query.text)
    if (!match) return []

    const params: unknown[] = [match]
    let sql = `
      SELECT content_hash, bm25(job_fts) AS rank
      FROM job_fts
      WHERE job_fts MATCH ?
    `
    if (query.platformId) {
      sql += ' AND platform_id = ?'
      params.push(query.platformId)
    }
    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as { content_hash: string; rank: number }[]
    // bm25 returns lower = better; expose a positive score where higher = better.
    return rows.map(r => ({ contentHash: r.content_hash, score: -r.rank }))
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM job_fts').get() as { n: number }).n
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Sanitize free text into a safe FTS5 MATCH expression: split into alphanumeric
 * tokens and OR them together, each quoted to neutralise FTS operators. Returns
 * '' if there are no usable tokens (caller treats as "no results").
 */
function toFtsMatch(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (tokens.length === 0) return ''
  return tokens.map(t => `"${t}"`).join(' OR ')
}
