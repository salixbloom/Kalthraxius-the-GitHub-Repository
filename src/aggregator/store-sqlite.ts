import Database from 'better-sqlite3'
import type { Enrichment, RawJob } from '../types.js'
import type { AggregatorStats, AggregatorStore, IndexedJob } from './store.js'

/**
 * Default AggregatorStore backed by SQLite. The enrichment is stored as a JSON
 * blob alongside the raw columns — the aggregator DB is its own file, distinct
 * from a scraper node's JobCache, and treats (raw + enrichment) as one indexed
 * unit, so a join buys nothing here.
 *
 * Persistence is the point: this is the "persistent node" of Phase 5. Reopening
 * the same dbPath after a restart recovers every job (no data loss).
 */
export class SqliteAggregatorStore implements AggregatorStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.init()
  }

  private init(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS indexed_jobs (
          content_hash   TEXT PRIMARY KEY,
          platform_id    TEXT NOT NULL,
          url            TEXT NOT NULL,
          title          TEXT NOT NULL,
          company        TEXT NOT NULL,
          location       TEXT NOT NULL,
          description    TEXT NOT NULL,
          salary         TEXT,
          posted_at      TEXT,
          scraped_at     INTEGER NOT NULL,
          salary_is_null INTEGER NOT NULL,
          enrichment     TEXT NOT NULL,
          ingested_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ij_platform ON indexed_jobs (platform_id);
        CREATE INDEX IF NOT EXISTS idx_ij_scraped  ON indexed_jobs (scraped_at);
      `)
      this.db.pragma('user_version = 1')
    }
  }

  upsert(indexed: IndexedJob): 'inserted' | 'updated' {
    const { job, enrichment } = indexed
    const existed = this.has(job.contentHash)
    this.db
      .prepare(`
        INSERT INTO indexed_jobs
          (content_hash, platform_id, url, title, company, location, description,
           salary, posted_at, scraped_at, salary_is_null, enrichment, ingested_at)
        VALUES
          (@contentHash, @platformId, @url, @title, @company, @location, @description,
           @salary, @postedAt, @scrapedAt, @salaryIsNull, @enrichment, @ingestedAt)
        ON CONFLICT(content_hash) DO UPDATE SET
          platform_id    = excluded.platform_id,
          url            = excluded.url,
          title          = excluded.title,
          company        = excluded.company,
          location       = excluded.location,
          description    = excluded.description,
          salary         = excluded.salary,
          posted_at      = excluded.posted_at,
          scraped_at     = excluded.scraped_at,
          salary_is_null = excluded.salary_is_null,
          enrichment     = excluded.enrichment,
          ingested_at    = excluded.ingested_at
      `)
      .run({
        contentHash: job.contentHash,
        platformId: job.platformId,
        url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
        salary: job.salary,
        postedAt: job.postedAt,
        scrapedAt: job.scrapedAt,
        salaryIsNull: enrichment.salary.value === null ? 1 : 0,
        enrichment: JSON.stringify(enrichment),
        ingestedAt: Date.now(),
      })
    return existed ? 'updated' : 'inserted'
  }

  get(contentHash: string): IndexedJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM indexed_jobs WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined
    return row ? rowToIndexed(row) : undefined
  }

  has(contentHash: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM indexed_jobs WHERE content_hash = ? LIMIT 1')
        .get(contentHash) !== undefined
    )
  }

  allHashes(): string[] {
    const rows = this.db.prepare('SELECT content_hash FROM indexed_jobs').all() as {
      content_hash: string
    }[]
    return rows.map(r => r.content_hash)
  }

  all(limit?: number): IndexedJob[] {
    const sql =
      'SELECT * FROM indexed_jobs ORDER BY scraped_at DESC' +
      (limit !== undefined ? ' LIMIT ?' : '')
    const stmt = this.db.prepare(sql)
    const rows = (limit !== undefined ? stmt.all(limit) : stmt.all()) as Record<string, unknown>[]
    return rows.map(rowToIndexed)
  }

  stats(): AggregatorStats {
    const total = this.count()
    const byPlatformRows = this.db
      .prepare('SELECT platform_id, COUNT(*) AS n FROM indexed_jobs GROUP BY platform_id')
      .all() as { platform_id: string; n: number }[]
    const byPlatform: Record<string, number> = {}
    for (const r of byPlatformRows) byPlatform[r.platform_id] = r.n

    const nullSalary = (
      this.db.prepare('SELECT COUNT(*) AS n FROM indexed_jobs WHERE salary_is_null = 1').get() as {
        n: number
      }
    ).n
    const newest = (
      this.db.prepare('SELECT COALESCE(MAX(scraped_at), 0) AS m FROM indexed_jobs').get() as {
        m: number
      }
    ).m

    return {
      totalJobs: total,
      byPlatform,
      salaryNullRate: total === 0 ? 0 : nullSalary / total,
      newestScrapedAt: newest,
    }
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM indexed_jobs').get() as { n: number }).n
  }

  close(): void {
    this.db.close()
  }
}

function rowToIndexed(row: Record<string, unknown>): IndexedJob {
  const job: RawJob = {
    contentHash: row['content_hash'] as string,
    platformId: row['platform_id'] as string,
    url: row['url'] as string,
    title: row['title'] as string,
    company: row['company'] as string,
    location: row['location'] as string,
    description: row['description'] as string,
    salary: (row['salary'] as string | null) ?? null,
    postedAt: (row['posted_at'] as string | null) ?? null,
    scrapedAt: row['scraped_at'] as number,
  }
  const enrichment = JSON.parse(row['enrichment'] as string) as Enrichment
  return { job, enrichment }
}
