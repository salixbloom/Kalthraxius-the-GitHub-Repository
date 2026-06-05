import { fetch } from '../fetcher.js'
import { fetchHardened } from '../stealth-fetcher.js'
import { extractJobs, extractNextLink } from '../extractor.js'
import { extractJsonLdJobs } from '../json-ld-fetcher.js'
import { publishJob } from '../gossip.js'
import { claimTarget, hasActiveClaim } from '../scrape-claim.js'
import { RateLimiter } from '../rate-limiter.js'
import { pageUrl, maxPagesFor } from '../pagination.js'
import { log } from '../logger.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { PlatformDescriptor, RawJob } from '../types.js'

export interface ScrapePassOptions {
  /** Scrape-claim TTL (ms). */
  claimTtlMs: number
  /** Use the stealth fetcher (anti-bot, jitter) instead of the plain one. */
  stealth: boolean
  /**
   * Shared rate limiter enforcing the descriptor's `rateLimit`. Pass the SAME
   * instance across passes so the platform is paced over time, not just within
   * one pass. Omit to skip throttling (e.g. tests).
   */
  limiter?: RateLimiter
}

/**
 * One scrape pass, shared by the scraper and aggregator-scraper entrypoints.
 *
 * Walks the board's pages (when `pagination.enabled`; otherwise just the base
 * URL). For each page it:
 *   1. skips the page if another node holds an active DHT claim on that page URL
 *      (claims are PER-PAGE, so nodes can split a board's pages);
 *   2. otherwise claims it, rate-limits, fetches, extracts (selectors →
 *      hash-stamped RawJobs), and gossips each job on the per-platform topic.
 *
 * Stops early when a page yields zero jobs (end of results), at `maxPages`, or —
 * for cursor pagination — when no next link is found. Returns the total number
 * of jobs published across all pages.
 */
export async function runScrapePass(
  node: KalthraxiusNode,
  descriptor: PlatformDescriptor,
  url: string,
  opts: ScrapePassOptions,
): Promise<number> {
  return walkPages(
    descriptor,
    url,
    pageUrl => scrapeOnePage(node, descriptor, pageUrl, opts),
    (html, currentUrl) => extractNextLink(html, descriptor, currentUrl),
  )
}

export interface PageResult {
  /** Whether this page was skipped (a peer already holds its claim). */
  skipped: boolean
  /** Jobs extracted from this page (0 if skipped). */
  jobCount: number
  /** Jobs actually published from this page. */
  published: number
  /** The page HTML, needed for cursor next-link extraction (null if skipped). */
  html: string | null
}

/**
 * Page-walk control flow, factored out of I/O so the stop conditions are
 * unit-testable. Walks pages (computed for page/offset, cursor-followed for
 * cursor) up to `maxPages`, invoking `scrapePage` per URL and `nextCursor` to
 * find the next URL in cursor mode. Returns total jobs published.
 *
 * Stop conditions:
 *   - reached `maxPages`;
 *   - a page yielded zero jobs (end of results) — UNLESS it was skipped because
 *     a peer holds its claim, in which case we keep walking (that peer has it);
 *   - cursor mode: `nextCursor` returns null/empty, or repeats the current URL.
 */
export async function walkPages(
  descriptor: PlatformDescriptor,
  baseUrl: string,
  scrapePage: (url: string) => Promise<PageResult>,
  nextCursor: (html: string, currentUrl: string) => Promise<string | null>,
): Promise<number> {
  const maxPages = maxPagesFor(descriptor)
  const isCursor = descriptor.pagination.type === 'cursor'

  let published = 0
  let pageIndex = 0
  let currentUrl = pageUrl(baseUrl, descriptor.pagination, 0)

  while (pageIndex < maxPages) {
    const result = await scrapePage(currentUrl)
    published += result.published

    if (!result.skipped && result.jobCount === 0) break

    pageIndex++
    if (pageIndex >= maxPages) break

    if (isCursor) {
      const next = result.html ? await nextCursor(result.html, currentUrl) : null
      if (!next || next === currentUrl) break
      currentUrl = next
    } else {
      currentUrl = pageUrl(baseUrl, descriptor.pagination, pageIndex)
    }
  }

  return published
}

async function scrapeOnePage(
  node: KalthraxiusNode,
  descriptor: PlatformDescriptor,
  url: string,
  opts: ScrapePassOptions,
): Promise<PageResult> {
  // Per-page coordination: don't crawl a page another peer is already on.
  if (await hasActiveClaim(node.services.dht, descriptor.id, url)) {
    log.scrape.debug(`${url} — already claimed by a peer, skipping`)
    return { skipped: true, jobCount: 0, published: 0, html: null }
  }
  await claimTarget(node.services.dht, descriptor.id, url, node.peerId.toString(), opts.claimTtlMs)

  // Honor the platform's politeness limit before every fetch.
  await opts.limiter?.acquire(descriptor.id, descriptor.rateLimit.requestsPerMinute)

  const { html } = opts.stealth
    ? await fetchHardened(url, descriptor)
    : await fetch(url, descriptor)

  const { jobs, stats } = descriptor.fetcherMode === 'json-ld-list'
    ? await extractJsonLdJobs(html, descriptor)
    : await extractJobs(html, descriptor)
  log.scrape.info(`${url} → matched ${stats.matched} row(s), extracted ${jobs.length} job(s)`)

  let published = 0
  for (const job of jobs as RawJob[]) {
    await publishJob(node.services.pubsub, job)
    published++
  }
  return { skipped: false, jobCount: jobs.length, published, html }
}
