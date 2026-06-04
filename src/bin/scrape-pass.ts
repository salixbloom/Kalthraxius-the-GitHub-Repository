import { fetch } from '../fetcher.js'
import { fetchHardened } from '../stealth-fetcher.js'
import { extractJobs } from '../extractor.js'
import { publishJob } from '../gossip.js'
import { claimTarget, hasActiveClaim } from '../scrape-claim.js'
import { RateLimiter } from '../rate-limiter.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { PlatformDescriptor } from '../types.js'

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
 * One scrape pass, shared by the scraper and aggregator-scraper entrypoints:
 *   1. Skip if another node holds an active DHT claim on this target.
 *   2. Otherwise claim it, fetch, extract (selectors → hash-stamped RawJobs),
 *      and gossip each job on its per-platform topic.
 *
 * Returns the number of jobs published (0 if the target was already claimed).
 */
export async function runScrapePass(
  node: KalthraxiusNode,
  descriptor: PlatformDescriptor,
  url: string,
  opts: ScrapePassOptions,
): Promise<number> {
  // Coordination: don't crawl a target another peer is already on.
  if (await hasActiveClaim(node.services.dht, descriptor.id, url)) {
    console.log(`[scrape] ${url} is already claimed by a peer — skipping`)
    return 0
  }
  await claimTarget(node.services.dht, descriptor.id, url, node.peerId.toString(), opts.claimTtlMs)

  // Honor the platform's politeness limit before every fetch.
  await opts.limiter?.acquire(descriptor.id, descriptor.rateLimit.requestsPerMinute)

  const { html } = opts.stealth
    ? await fetchHardened(url, descriptor)
    : await fetch(url, descriptor)

  const { jobs, stats } = await extractJobs(html, descriptor)
  console.log(`[scrape] ${url} → matched ${stats.matched} row(s), extracted ${jobs.length} job(s)`)

  for (const job of jobs) {
    await publishJob(node.services.pubsub, job)
  }
  return jobs.length
}
