import type Database from 'better-sqlite3'
import { ENRICHMENT_SCHEMA_VERSION } from './types.js'
import type { Enrichment, RawJob, SalaryPeriod, SeniorityLevel, SkillMatch } from './types.js'

/**
 * Persistence for derived/enriched fields, kept in a table separate from raw
 * `jobs` so the raw payload stays immutable and re-enrichment is a clean
 * row rewrite. Shares the JobCache connection (same SQLite file).
 */
export class EnrichmentStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Upsert an enrichment row (last-writer-wins on content_hash). */
  put(e: Enrichment): void {
    this.db
      .prepare(`
        INSERT INTO enrichments
          (content_hash, salary_min, salary_max, salary_currency, salary_period,
           salary_conf, yoe, yoe_conf, seniority, seniority_conf, skills,
           schema_version, enriched_at)
        VALUES
          (@contentHash, @salaryMin, @salaryMax, @salaryCurrency, @salaryPeriod,
           @salaryConf, @yoe, @yoeConf, @seniority, @seniorityConf, @skills,
           @schemaVersion, @enrichedAt)
        ON CONFLICT(content_hash) DO UPDATE SET
          salary_min      = excluded.salary_min,
          salary_max      = excluded.salary_max,
          salary_currency = excluded.salary_currency,
          salary_period   = excluded.salary_period,
          salary_conf     = excluded.salary_conf,
          yoe             = excluded.yoe,
          yoe_conf        = excluded.yoe_conf,
          seniority       = excluded.seniority,
          seniority_conf  = excluded.seniority_conf,
          skills          = excluded.skills,
          schema_version  = excluded.schema_version,
          enriched_at     = excluded.enriched_at
      `)
      .run({
        contentHash: e.contentHash,
        salaryMin: e.salary.value?.min ?? null,
        salaryMax: e.salary.value?.max ?? null,
        salaryCurrency: e.salary.value?.currency ?? null,
        salaryPeriod: e.salary.value?.period ?? null,
        salaryConf: e.salary.confidence,
        yoe: e.yoe.value,
        yoeConf: e.yoe.confidence,
        seniority: e.seniority.value,
        seniorityConf: e.seniority.confidence,
        skills: JSON.stringify(e.skills),
        schemaVersion: e.schemaVersion,
        enrichedAt: e.enrichedAt,
      })
  }

  get(contentHash: string): Enrichment | undefined {
    const row = this.db
      .prepare('SELECT * FROM enrichments WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined
    return row ? this.rowToEnrichment(row) : undefined
  }

  /**
   * The migration/queue query: raw jobs that have no enrichment yet, or whose
   * enrichment was produced by an older extractor revision. Returns the raw
   * rows that need (re-)processing, oldest-scraped first, capped by `limit`.
   */
  pendingJobs(limit: number, currentVersion = ENRICHMENT_SCHEMA_VERSION): RawJob[] {
    const rows = this.db
      .prepare(`
        SELECT j.*
        FROM jobs j
        LEFT JOIN enrichments e ON e.content_hash = j.content_hash
        WHERE e.content_hash IS NULL OR e.schema_version < ?
        ORDER BY j.scraped_at ASC
        LIMIT ?
      `)
      .all(currentVersion, limit) as Record<string, unknown>[]
    return rows.map(rowToRawJob)
  }

  pendingCount(currentVersion = ENRICHMENT_SCHEMA_VERSION): number {
    return (
      this.db
        .prepare(`
          SELECT COUNT(*) AS n
          FROM jobs j
          LEFT JOIN enrichments e ON e.content_hash = j.content_hash
          WHERE e.content_hash IS NULL OR e.schema_version < ?
        `)
        .get(currentVersion) as { n: number }
    ).n
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM enrichments').get() as { n: number }).n
  }

  private rowToEnrichment(row: Record<string, unknown>): Enrichment {
    const min = row['salary_min'] as number | null
    const max = row['salary_max'] as number | null
    const currency = row['salary_currency'] as string | null
    const period = row['salary_period'] as SalaryPeriod | null
    const hasSalary = min !== null || max !== null
    return {
      contentHash: row['content_hash'] as string,
      salary: {
        value: hasSalary ? { min, max, currency, period } : null,
        confidence: row['salary_conf'] as number,
      },
      yoe: {
        value: (row['yoe'] as number | null) ?? null,
        confidence: row['yoe_conf'] as number,
      },
      seniority: {
        value: (row['seniority'] as SeniorityLevel | null) ?? null,
        confidence: row['seniority_conf'] as number,
      },
      skills: JSON.parse(row['skills'] as string) as SkillMatch[],
      schemaVersion: row['schema_version'] as number,
      enrichedAt: row['enriched_at'] as number,
    }
  }
}

function rowToRawJob(row: Record<string, unknown>): RawJob {
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
