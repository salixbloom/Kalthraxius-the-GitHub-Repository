import { request } from 'undici'
import { getRedirectDispatcher } from './fetcher.js'
import { contentHash } from './job-hash.js'
import { log } from './logger.js'
import type { PlatformDescriptor, RawJob } from './types.js'
import type { ExtractResult } from './extractor.js'

/**
 * Fetcher for `fetcherMode: "workable-api"`.
 *
 * Workable's aggregator site (jobs.workable.com) embeds the first page of
 * results in window.jobBoard on the listing page, then exposes a plain
 * unauthenticated API for subsequent pages:
 *
 *   GET /api/v1/jobs?pageToken=<base64-cursor>
 *
 * Each response contains up to 20 jobs with full inline data (title, company,
 * location, description, salary, etc.) plus a nextPageToken for the next page.
 * This lets us walk N pages per pass without fetching individual detail pages.
 *
 * Page 1: extracted from window.jobBoard in the already-fetched listing HTML.
 * Pages 2+: fetched from /api/v1/jobs?pageToken=<token>.
 *
 * maxPages is controlled by descriptor.pagination.maxPages (default 1 = listing
 * page only). Set to e.g. 5 to get up to 100 jobs per pass.
 *
 * Note: results are sorted by Workable's default — featured first, then newest.
 */

const API_BASE = 'https://jobs.workable.com'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://jobs.workable.com/search/Alpha%20Centauri',
}

interface WorkableJob {
  id: string
  title: string
  description: string
  employmentType?: string
  created?: string
  url?: string
  locations?: string[]
  location?: { city?: string; subregion?: string; countryName?: string }
  company?: { title?: string }
  workplace?: string
}

interface WorkableApiResponse {
  totalSize: number
  nextPageToken: string | null
  jobs: WorkableJob[]
}

/** Extract the api/v1/jobs value object from window.jobBoard script blob. */
function extractWindowJobBoard(html: string): WorkableApiResponse | null {
  const jobsKey = '"api/v1/jobs":'
  const keyIdx = html.indexOf(jobsKey)
  if (keyIdx === -1) return null

  const braceStart = html.indexOf('{', keyIdx + jobsKey.length)
  if (braceStart === -1) return null

  let depth = 0, i = braceStart
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) break
  }

  try {
    const blob = JSON.parse(html.slice(braceStart, i + 1)) as { data?: WorkableApiResponse }
    return blob.data ?? null
  } catch {
    return null
  }
}

/** Fetch a subsequent page from the Workable API. */
async function fetchApiPage(pageToken: string): Promise<WorkableApiResponse | null> {
  const url = `${API_BASE}/api/v1/jobs?pageToken=${encodeURIComponent(pageToken)}`
  try {
    const { statusCode, body } = await request(url, {
      headers: HEADERS,
      dispatcher: getRedirectDispatcher(),
    })
    if (statusCode !== 200) {
      log.scrape.warn(`[workable-api] API returned ${statusCode} for pageToken fetch`)
      return null
    }
    return (await body.json()) as WorkableApiResponse
  } catch (err) {
    log.scrape.warn(`[workable-api] API fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Build a location string from a Workable job object. */
function buildLocation(job: WorkableJob): string {
  // Prefer the locations array (pre-formatted) if present
  if (job.locations?.length) return job.locations[0]!
  const loc = job.location
  if (!loc) return ''
  return [loc.city, loc.subregion, loc.countryName].filter(Boolean).join(', ')
}

/** Strip HTML tags from a description. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Map a WorkableJob to a RawJob. Returns null if missing required fields. */
function mapJob(job: WorkableJob, descriptor: PlatformDescriptor, scrapedAt: number): RawJob | null {
  if (!job.title || !job.url) return null

  const base = {
    contentHash: '',
    platformId: descriptor.id,
    url: job.url,
    title: job.title,
    company: job.company?.title ?? '',
    location: buildLocation(job),
    description: stripHtml(job.description ?? ''),
    salary: null,
    postedAt: job.created ?? null,
    scrapedAt,
  }
  return { ...base, contentHash: contentHash(base) }
}

/**
 * Extract all jobs across up to maxPages from the Workable API.
 *
 * `listingHtml` is the already-fetched listing page HTML (page 1 data comes
 * from window.jobBoard embedded there). Subsequent pages are fetched via the
 * /api/v1/jobs endpoint using the nextPageToken cursor chain.
 */
export async function extractWorkableJobs(
  listingHtml: string,
  descriptor: PlatformDescriptor,
  opts: { scrapedAt?: number } = {},
): Promise<ExtractResult> {
  const scrapedAt = opts.scrapedAt ?? Date.now()
  const maxPages = Math.max(1, descriptor.pagination.maxPages ?? 1)

  const jobs: RawJob[] = []
  const fieldCoverage: Record<string, number> = {
    title: 0, company: 0, location: 0, description: 0, salary: 0, postedAt: 0,
  }
  let totalMatched = 0

  // Page 1: from window.jobBoard in listing HTML
  const page1 = extractWindowJobBoard(listingHtml)
  if (!page1) {
    log.scrape.warn('[workable-api] window.jobBoard not found in listing HTML')
    return { jobs: [], stats: { matched: 0, fieldCoverage } }
  }

  log.scrape.info(`[workable-api] page 1 — ${page1.jobs.length} job(s), totalSize=${page1.totalSize}`)
  totalMatched += page1.jobs.length

  for (const wj of page1.jobs) {
    const job = mapJob(wj, descriptor, scrapedAt)
    if (!job) continue
    jobs.push(job)
    if (job.title) fieldCoverage['title'] = (fieldCoverage['title'] ?? 0) + 1
    if (job.company) fieldCoverage['company'] = (fieldCoverage['company'] ?? 0) + 1
    if (job.location) fieldCoverage['location'] = (fieldCoverage['location'] ?? 0) + 1
    if (job.description) fieldCoverage['description'] = (fieldCoverage['description'] ?? 0) + 1
    if (job.postedAt) fieldCoverage['postedAt'] = (fieldCoverage['postedAt'] ?? 0) + 1
  }

  // Pages 2+: follow nextPageToken chain
  let nextToken = page1.nextPageToken
  let pageNum = 2

  while (nextToken && pageNum <= maxPages) {
    const page = await fetchApiPage(nextToken)
    if (!page) break

    log.scrape.info(`[workable-api] page ${pageNum} — ${page.jobs.length} job(s)`)
    totalMatched += page.jobs.length

    for (const wj of page.jobs) {
      const job = mapJob(wj, descriptor, scrapedAt)
      if (!job) continue
      jobs.push(job)
      if (job.title) fieldCoverage['title'] = (fieldCoverage['title'] ?? 0) + 1
      if (job.company) fieldCoverage['company'] = (fieldCoverage['company'] ?? 0) + 1
      if (job.location) fieldCoverage['location'] = (fieldCoverage['location'] ?? 0) + 1
      if (job.description) fieldCoverage['description'] = (fieldCoverage['description'] ?? 0) + 1
      if (job.postedAt) fieldCoverage['postedAt'] = (fieldCoverage['postedAt'] ?? 0) + 1
    }

    if (!page.nextPageToken || page.jobs.length === 0) break
    nextToken = page.nextPageToken
    pageNum++
  }

  log.scrape.info(`[workable-api] done — ${jobs.length} job(s) mapped across ${pageNum - 1} page(s)`)
  return { jobs, stats: { matched: totalMatched, fieldCoverage } }
}
