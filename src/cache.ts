import Database from 'better-sqlite3'
import type { RawJob } from './types.js'

interface CacheOptions {
  dbPath: string
  maxSizeBytes: number
  ttlMs: number
}

export class JobCache {
  private db: Database.Database
  private maxSizeBytes: number
  private ttlMs: number

  constructor({ dbPath, maxSizeBytes, ttlMs }: CacheOptions) {
    this.maxSizeBytes = maxSizeBytes
    this.ttlMs = ttlMs
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        content_hash TEXT PRIMARY KEY,
        platform_id  TEXT NOT NULL,
        url          TEXT NOT NULL,
        title        TEXT NOT NULL,
        company      TEXT NOT NULL,
        location     TEXT NOT NULL,
        description  TEXT NOT NULL,
        salary       TEXT,
        posted_at    TEXT,
        scraped_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scraped_at ON jobs (scraped_at);
    `)
  }

  upsert(job: RawJob): 'inserted' | 'duplicate' {
    const existing = this.db
      .prepare('SELECT content_hash FROM jobs WHERE content_hash = ?')
      .get(job.contentHash)

    if (existing) return 'duplicate'

    this.db
      .prepare(`
        INSERT INTO jobs
          (content_hash, platform_id, url, title, company, location, description, salary, posted_at, scraped_at)
        VALUES
          (@contentHash, @platformId, @url, @title, @company, @location, @description, @salary, @postedAt, @scrapedAt)
      `)
      .run(job)

    this.evict()
    return 'inserted'
  }

  get(contentHash: string): RawJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined
    return row ? this.rowToJob(row) : undefined
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM jobs').get() as { n: number }).n
  }

  private evict() {
    const expiryCutoff = Date.now() - this.ttlMs
    this.db.prepare('DELETE FROM jobs WHERE scraped_at < ?').run(expiryCutoff)

    // Evict oldest entries until under size cap
    if (this.estimatedSizeBytes() > this.maxSizeBytes) {
      this.db.exec(`
        DELETE FROM jobs WHERE content_hash IN (
          SELECT content_hash FROM jobs ORDER BY scraped_at ASC LIMIT 10
        )
      `)
    }
  }

  private estimatedSizeBytes(): number {
    const pageCount = this.db.pragma('page_count', { simple: true }) as number
    const pageSize = this.db.pragma('page_size', { simple: true }) as number
    return pageCount * pageSize
  }

  private rowToJob(row: Record<string, unknown>): RawJob {
    return {
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
  }

  close() {
    this.db.close()
  }
}
