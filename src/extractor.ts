import { chromium } from 'playwright'
import { contentHash, locationHash } from './job-hash.js'
import type { Browser } from 'playwright'
import type { PlatformDescriptor, RawJob } from './types.js'

/**
 * HTML → RawJob extraction (Phase 8). The fetcher returns raw HTML; this turns
 * it into structured jobs by applying a descriptor's CSS selectors. It is also
 * where a job's canonical hashes are STAMPED (`contentHash`/`locationHash` via
 * job-hash.ts) — so every job that enters the network carries a verifiable
 * content hash, which is what makes the Phase 7 integrity gate meaningful.
 *
 * Uses Playwright's already-installed Chromium to parse (page.setContent +
 * querySelectorAll), so real-world HTML is handled by a real engine and no new
 * dependency is added.
 */

export interface ExtractStats {
  /** Number of job-list nodes the jobList selector matched. */
  matched: number
  /** Per-field counts of how many extracted jobs had a non-empty value. */
  fieldCoverage: Record<string, number>
}

export interface ExtractResult {
  jobs: RawJob[]
  stats: ExtractStats
}

/** Fields we try to pull per job, and whether they're required for a valid job. */
const FIELD_SELECTORS = [
  'title',
  'company',
  'location',
  'description',
  'salary',
  'postedAt',
] as const

/**
 * Extract jobs from an HTML document using the descriptor's selectors. `scrapedAt`
 * is stamped now; `contentHash`/`locationHash` are derived from the content so
 * two scrapers of the same posting agree.
 *
 * A shared `browser` may be passed to amortise launch cost across many pages;
 * otherwise one is launched and closed per call.
 */
export async function extractJobs(
  html: string,
  descriptor: PlatformDescriptor,
  opts: { browser?: Browser; scrapedAt?: number } = {},
): Promise<ExtractResult> {
  const ownsBrowser = !opts.browser
  const browser = opts.browser ?? (await chromium.launch({ headless: true }))
  const scrapedAt = opts.scrapedAt ?? Date.now()

  try {
    const page = await browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded' })

      const sel = descriptor.selectors
      const rows = await page.$$(sel.jobList)
      const fieldCoverage: Record<string, number> = {}
      for (const f of FIELD_SELECTORS) fieldCoverage[f] = 0

      const jobs: RawJob[] = []
      for (const row of rows) {
        const get = async (selector?: string): Promise<string | null> => {
          if (!selector) return null
          const el = await row.$(selector)
          if (!el) return null
          const text = (await el.textContent())?.trim()
          return text && text.length > 0 ? text : null
        }

        const linkEl = await row.$(sel.jobLink)
        const href = linkEl ? await linkEl.getAttribute('href') : null
        const url = absoluteUrl(href, descriptor.baseUrl)

        const title = await get(sel.title)
        const company = await get(sel.company)
        const location = await get(sel.location)
        const description = await get(sel.description)
        const salary = await get(sel.salary)
        const postedAt = await get(sel.postedAt)

        for (const [f, v] of Object.entries({ title, company, location, description, salary, postedAt })) {
          if (v) fieldCoverage[f] = (fieldCoverage[f] ?? 0) + 1
        }

        // A job needs at least a URL and a title to be meaningful; skip junk rows.
        if (!url || !title) continue

        const base = {
          contentHash: '',
          platformId: descriptor.id,
          url,
          title,
          company: company ?? '',
          location: location ?? '',
          description: description ?? '',
          salary,
          postedAt,
          scrapedAt,
        }
        jobs.push({ ...base, contentHash: contentHash(base) })
      }

      return { jobs, stats: { matched: rows.length, fieldCoverage } }
    } finally {
      await page.close()
    }
  } finally {
    if (ownsBrowser) await browser.close()
  }
}

/**
 * Cursor pagination: extract the "next page" URL from a page's HTML via the
 * descriptor's `selectors.nextLink`, resolved to an absolute URL against
 * `currentUrl`. Returns null when there's no next link (the end of the board) or
 * no `nextLink` selector is configured. Pass a shared `browser` to amortise
 * launch across pages.
 */
export async function extractNextLink(
  html: string,
  descriptor: PlatformDescriptor,
  currentUrl: string,
  opts: { browser?: Browser } = {},
): Promise<string | null> {
  const selector = descriptor.selectors.nextLink
  if (!selector) return null

  const ownsBrowser = !opts.browser
  const browser = opts.browser ?? (await chromium.launch({ headless: true }))
  try {
    const page = await browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      const el = await page.$(selector)
      const href = el ? await el.getAttribute('href') : null
      return absoluteUrl(href, currentUrl)
    } finally {
      await page.close()
    }
  } finally {
    if (ownsBrowser) await browser.close()
  }
}

/** Stamp the canonical hashes onto a raw job (content + location). */
export function stampHashes(job: Omit<RawJob, 'contentHash'>): RawJob {
  return { ...job, contentHash: contentHash({ ...job, contentHash: '' }) }
}

export { locationHash }

function absoluteUrl(href: string | null, baseUrl: string): string | null {
  if (!href) return null
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return null
  }
}
