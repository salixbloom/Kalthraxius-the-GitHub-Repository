/**
 * Scraper node entrypoint.
 *
 * On an interval: claims a target in the DHT (so peers don't double-crawl),
 * fetches it, extracts postings via the descriptor's selectors, and gossips
 * each (hash-stamped) job on its per-platform topic.
 *
 * Run: node --experimental-strip-types src/bin/scraper.ts
 *
 * Environment (plus the base vars in common.ts):
 *   KAL_DESCRIPTOR      path to a platform descriptor JSON (required)
 *   KAL_SCRAPE_MS       interval between scrape passes in ms (default 300000 = 5 min)
 *   KAL_CLAIM_TTL_MS    scrape-claim TTL in ms (default 1800000 = 30 min)
 *   KAL_STEALTH         "1" to use the hardened stealth fetcher (browser mode)
 *   KAL_ONCE            "1" to run a single pass and exit (useful for cron/testing)
 *
 * The scrape URL is the descriptor's `baseUrl`; politeness throttling within a
 * pass comes from the descriptor's `rateLimit`. Both are platform properties,
 * not node config, so they live in the descriptor — not the environment.
 */
import { readFileSync } from 'node:fs'
import { baseConfig, env, envBool, envInt, startNode, runUntilSignal, fail, errMsg } from './common.js'
import { runScrapePass } from './scrape-pass.js'
import { RateLimiter } from '../rate-limiter.js'
import { log, flushLogs } from '../logger.js'
import type { PlatformDescriptor } from '../types.js'
import type { KalthraxiusNode } from '../p2p-node.js'

async function main(): Promise<void> {
  const cfg = baseConfig()
  const descriptorPath = env('KAL_DESCRIPTOR')
  if (!descriptorPath) fail('KAL_DESCRIPTOR is required (path to a platform descriptor JSON)')

  const descriptor = JSON.parse(readFileSync(descriptorPath!, 'utf8')) as PlatformDescriptor
  const url = descriptor.baseUrl
  const intervalMs = envInt('KAL_SCRAPE_MS', 5 * 60_000)
  const claimTtlMs = envInt('KAL_CLAIM_TTL_MS', 30 * 60_000)
  const stealth = envBool('KAL_STEALTH')
  const once = envBool('KAL_ONCE')

  const node = await startNode(cfg)
  log.scraper.info(
    `platform=${descriptor.id} url=${url} stealth=${stealth} interval=${intervalMs}ms rateLimit=${descriptor.rateLimit.requestsPerMinute}/min`,
  )

  // Give the gossip mesh time to form before the first publish. GossipSub mesh
  // negotiation takes several heartbeat rounds; 1s is not enough over a real
  // network — 5s is the safe minimum.
  await new Promise(r => setTimeout(r, 5_000))

  // One limiter for the whole node lifetime so passes are paced over time.
  const limiter = new RateLimiter()
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const pass = async (): Promise<void> => {
    if (stopped) return
    try {
      const n = await runScrapePass(node as KalthraxiusNode, descriptor, url, { claimTtlMs, stealth, limiter })
      log.scraper.info(`pass complete — published ${n} job(s)`)
    } catch (err) {
      log.scraper.error(`pass failed: ${errMsg(err)}`)
    }
  }

  await pass()
  if (once) {
    await node.stop()
    return
  }

  timer = setInterval(() => void pass(), intervalMs)
  timer.unref?.()

  await runUntilSignal(async () => {
    stopped = true
    if (timer) clearInterval(timer)
    await node.stop()
    await flushLogs()
  })
}

main().catch(err => {
  log.error.error(String(err))
  process.exit(1)
})
