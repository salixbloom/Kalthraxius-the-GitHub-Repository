export type FetcherMode = 'http' | 'browser' | 'json-ld-list' | 'workable-api'

/**
 * Field mapping for `fetcherMode: "json-ld-list"`. The listing page is expected
 * to contain either a `window.jobBoard` script blob (Workable pattern) or a
 * JSON-LD `ItemList` with job URLs. Each detail URL is then fetched and its
 * `JobPosting` JSON-LD block is parsed.
 *
 * Field paths are dot-notation into the JSON-LD `JobPosting` object
 * (e.g. "hiringOrganization.name", "jobLocation.address.addressLocality").
 * Set a field to null to leave it empty.
 */
export interface JsonLdMapping {
  /** Where to find job URLs on the listing page: "window-job-board" or "item-list-json-ld". */
  listingSource: 'window-job-board' | 'item-list-json-ld'
  /** Dot-path into each JobPosting object for the job title. Default: "title". */
  title?: string
  /** Dot-path for company name. Default: "hiringOrganization.name". */
  company?: string
  /** Dot-path for location string. Default: "jobLocation.address.addressLocality". */
  location?: string
  /** Dot-path for description HTML. Default: "description". */
  description?: string
  /** Dot-path for salary text, or null to skip. Default: "baseSalary.value.value". */
  salary?: string | null
  /** Dot-path for posted date, or null to skip. Default: "datePosted". */
  postedAt?: string | null
}

export interface PlatformDescriptor {
  id: string
  name: string
  baseUrl: string
  fetcherMode: FetcherMode
  rateLimit: {
    requestsPerMinute: number
  }
  /**
   * Required when fetcherMode is "json-ld-list". Describes how to extract jobs
   * from a JSON-LD listing + detail-page pattern (e.g. Workable aggregator).
   * Ignored for "http" and "browser" modes.
   */
  jsonLdMapping?: JsonLdMapping
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
  /**
   * CSS selectors for HTML extraction. Required for "http" and "browser" modes.
   * Omit (or set to null) for "json-ld-list" mode, which uses `jsonLdMapping`
   * instead.
   */
  selectors?: {
    jobList: string
    jobLink: string
    title: string
    company: string
    location: string
    description: string
    salary?: string | null
    postedAt?: string | null
    /** Cursor pagination only: selector for the "next page" link (its href). */
    nextLink?: string
  } | null
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
