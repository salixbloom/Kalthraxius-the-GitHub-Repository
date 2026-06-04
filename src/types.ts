export type FetcherMode = 'http' | 'browser'

export interface PlatformDescriptor {
  id: string
  name: string
  baseUrl: string
  fetcherMode: FetcherMode
  rateLimit: {
    requestsPerMinute: number
  }
  pagination: {
    /**
     * When false (or omitted), only the base URL is scraped — pagination is off.
     * When true, the scraper crawls pages per `type` up to `maxPages`, stopping
     * early on an empty page (or, for cursor, when no next link is found).
     */
    enabled?: boolean
    /**
     * - `page`   — pageParam carries a 1-based page number (?page=1, ?page=2…).
     * - `offset` — pageParam carries a row offset stepped by pageSize
     *              (?page=0, ?page=25, ?page=50…).
     * - `cursor` — the next page's URL is read from the current page's HTML via
     *              `selectors.nextLink`; not computed. pageParam/pageSize unused.
     */
    type: 'offset' | 'cursor' | 'page'
    pageParam: string
    pageSize: number
    maxPages: number
  }
  selectors: {
    jobList: string
    jobLink: string
    title: string
    company: string
    location: string
    description: string
    salary?: string
    postedAt?: string
    /** Cursor pagination only: selector for the "next page" link (its href). */
    nextLink?: string
  }
}

export interface RawJob {
  contentHash: string
  platformId: string
  url: string
  title: string
  company: string
  location: string
  description: string
  salary: string | null
  postedAt: string | null
  scrapedAt: number
}

/**
 * Current enrichment schema version. Bump this whenever an extractor changes
 * in a way that should re-process already-enriched records. The enrichment
 * worker re-queues everything `WHERE schema_version < ENRICHMENT_SCHEMA_VERSION`,
 * so a bump doubles as the migration trigger.
 */
export const ENRICHMENT_SCHEMA_VERSION = 1

export type SeniorityLevel =
  | 'intern'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'lead'
  | 'manager'
  | 'director'
  | 'executive'

export type SalaryPeriod = 'year' | 'month' | 'week' | 'day' | 'hour'

export interface SalaryExtraction {
  min: number | null
  max: number | null
  currency: string | null
  period: SalaryPeriod | null
}

/**
 * A field that may be absent. `value === null` means "could not extract"
 * (the plan's null policy). `confidence` is 0 when null, otherwise (0, 1].
 */
export interface EnrichedField<T> {
  value: T
  confidence: number
}

export interface SkillMatch {
  id: string
  label: string
  confidence: number
}

export interface Enrichment {
  contentHash: string
  salary: EnrichedField<SalaryExtraction | null>
  yoe: EnrichedField<number | null>
  seniority: EnrichedField<SeniorityLevel | null>
  skills: SkillMatch[]
  schemaVersion: number
  enrichedAt: number
}
