import { request } from 'undici'
import { getRedirectDispatcher } from './fetcher.js'
import { contentHash } from './job-hash.js'
import { log } from './logger.js'
import type { PlatformDescriptor, RawJob, JsonLdMapping } from './types.js'
import type { ExtractResult } from './extractor.js'

/**
 * Fetcher for `fetcherMode: "json-ld-list"`.
 *
 * Two-phase extraction:
 *   1. Fetch the listing page and extract job detail URLs — either from the
 *      Workable-style `window.jobBoard` initialState script blob, or from a
 *      JSON-LD `ItemList` block.
 *   2. Fetch each detail URL and parse its `JobPosting` JSON-LD block into a
 *      `RawJob`, mapping fields via `descriptor.jsonLdMapping`.
 *
 * Returns an ExtractResult so it plugs into the same pipeline as extractJobs.
 * Detail fetches are serialised (rate limiting is handled upstream by the
 * RateLimiter in scrape-pass, which calls acquire once per page URL — here the
 * "page" is the listing, so detail fetches are not individually rate-limited;
 * keep `rateLimit.requestsPerMinute` conservative to account for this).
 */

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
}

async function fetchText(url: string): Promise<string> {
  const { body } = await request(url, {
    headers: DEFAULT_HEADERS,
    dispatcher: getRedirectDispatcher(),
  })
  return body.text()
}

/** Extract job detail URLs from a Workable-style window.jobBoard script blob.
 *
 * The blob is a JS object literal (unquoted keys), NOT valid JSON, so we
 * cannot parse the whole thing. Instead we locate the "api/v1/jobs" key
 * (which IS quoted because it contains a slash) and extract only its value
 * object, which IS valid JSON (it comes straight from the API response).
 */
function extractUrlsFromWindowJobBoard(html: string): string[] {
  // Target: "api/v1/jobs":{"status":200,"data":{"jobs":[...]}}
  const jobsKey = '"api/v1/jobs":'
  const keyIdx = html.indexOf(jobsKey)
  if (keyIdx === -1) return []

  // Find the opening brace of the value object
  const braceStart = html.indexOf('{', keyIdx + jobsKey.length)
  if (braceStart === -1) return []

  // Walk forward matching braces to find the closing brace
  let depth = 0
  let i = braceStart
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(html.slice(braceStart, i + 1))
  } catch {
    return []
  }

  // Navigate: {status, data: {jobs: [{url, ...}]}}
  const data = (parsed as Record<string, unknown>)['data']
  if (!data || typeof data !== 'object') return []
  const jobs = (data as Record<string, unknown>)['jobs']
  if (!Array.isArray(jobs)) return []

  return jobs
    .map((j: unknown) => (j as Record<string, unknown>)['url'])
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
}

/** Extract job detail URLs from a JSON-LD ItemList block. */
function extractUrlsFromItemList(html: string): string[] {
  const urls: string[] = []
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>)['@type'] === 'ItemList'
    ) {
      const items = (parsed as Record<string, unknown>)['itemListElement']
      if (Array.isArray(items)) {
        for (const item of items) {
          const u = (item as Record<string, unknown>)['url']
          if (typeof u === 'string' && u.length > 0) urls.push(u)
        }
      }
    }
  }
  return urls
}

/** Parse all JSON-LD blocks from an HTML page, returning the first JobPosting. */
function extractJobPosting(html: string): Record<string, unknown> | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>)['@type'] === 'JobPosting'
    ) {
      return parsed as Record<string, unknown>
    }
  }
  return null
}

/** Resolve a dot-notation path into a nested object, returning a string or null. */
function dotGet(obj: Record<string, unknown>, path: string): string | null {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[part]
  }
  if (cur === null || cur === undefined) return null
  if (typeof cur === 'string') return cur.trim() || null
  if (typeof cur === 'number') return String(cur)
  return null
}

/** Strip HTML tags from a description string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Map a JobPosting JSON-LD object to a RawJob using the descriptor's mapping. */
function mapJobPosting(
  posting: Record<string, unknown>,
  url: string,
  descriptor: PlatformDescriptor,
  scrapedAt: number,
): RawJob | null {
  const m: JsonLdMapping = descriptor.jsonLdMapping ?? { listingSource: 'item-list-json-ld' }

  const title = dotGet(posting, m.title ?? 'title')
  if (!title) return null

  const company = dotGet(posting, m.company ?? 'hiringOrganization.name') ?? ''

  // Location: try the configured path, then fall back to common JobPosting paths
  const locationPath = m.location ?? 'jobLocation.address.addressLocality'
  let location = dotGet(posting, locationPath)
  if (!location) {
    // Common fallback: jobLocation[0].address.addressLocality for array jobLocation
    const jobLoc = posting['jobLocation']
    if (Array.isArray(jobLoc) && jobLoc.length > 0) {
      location = dotGet(jobLoc[0] as Record<string, unknown>, 'address.addressLocality')
    }
  }

  const rawDescription = dotGet(posting, m.description ?? 'description') ?? ''
  // Descriptions from JSON-LD are often HTML — strip tags for the plain-text field
  const description = stripHtml(rawDescription)

  const salary = m.salary === null
    ? null
    : dotGet(posting, m.salary ?? 'baseSalary.value.value')

  const postedAt = m.postedAt === null
    ? null
    : dotGet(posting, m.postedAt ?? 'datePosted')

  const base = {
    contentHash: '',
    platformId: descriptor.id,
    url,
    title,
    company,
    location: location ?? '',
    description,
    salary,
    postedAt,
    scrapedAt,
  }
  return { ...base, contentHash: contentHash(base) }
}

/**
 * Main entry point. Fetches the listing page, extracts detail URLs, fetches
 * each detail page, parses JobPosting JSON-LD, and returns structured jobs.
 *
 * `listingHtml` is the already-fetched listing page HTML (from fetchHttp in
 * scrape-pass, so it fits the same fetch → extract pipeline).
 */
export async function extractJsonLdJobs(
  listingHtml: string,
  descriptor: PlatformDescriptor,
  opts: { scrapedAt?: number } = {},
): Promise<ExtractResult> {
  const scrapedAt = opts.scrapedAt ?? Date.now()
  const mapping = descriptor.jsonLdMapping ?? { listingSource: 'item-list-json-ld' }

  const detailUrls =
    mapping.listingSource === 'window-job-board'
      ? extractUrlsFromWindowJobBoard(listingHtml)
      : extractUrlsFromItemList(listingHtml)

  log.scrape.info(`[json-ld] listing source=${mapping.listingSource} found ${detailUrls.length} detail URL(s)`)

  const jobs: RawJob[] = []
  const fieldCoverage: Record<string, number> = {
    title: 0, company: 0, location: 0, description: 0, salary: 0, postedAt: 0,
  }

  for (const url of detailUrls) {
    let detailHtml: string
    try {
      detailHtml = await fetchText(url)
      log.scrape.debug(`[json-ld] fetched detail ${url}`)
    } catch (err) {
      log.scrape.warn(`[json-ld] failed to fetch detail ${url}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const posting = extractJobPosting(detailHtml)
    if (!posting) {
      log.scrape.warn(`[json-ld] no JobPosting JSON-LD found at ${url}`)
      continue
    }

    const job = mapJobPosting(posting, url, descriptor, scrapedAt)
    if (!job) {
      log.scrape.warn(`[json-ld] could not map JobPosting to RawJob at ${url} (missing title?)`)
      continue
    }

    jobs.push(job)
    if (job.title) fieldCoverage['title'] = (fieldCoverage['title'] ?? 0) + 1
    if (job.company) fieldCoverage['company'] = (fieldCoverage['company'] ?? 0) + 1
    if (job.location) fieldCoverage['location'] = (fieldCoverage['location'] ?? 0) + 1
    if (job.description) fieldCoverage['description'] = (fieldCoverage['description'] ?? 0) + 1
    if (job.salary) fieldCoverage['salary'] = (fieldCoverage['salary'] ?? 0) + 1
    if (job.postedAt) fieldCoverage['postedAt'] = (fieldCoverage['postedAt'] ?? 0) + 1
  }

  return { jobs, stats: { matched: detailUrls.length, fieldCoverage } }
}
