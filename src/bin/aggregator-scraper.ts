/**
 * Combined aggregator + scraper entrypoint.
 *
 * Runs both roles on a single libp2p node (one identity, one DHT/gossip mesh):
 * it scrapes a target on an interval AND indexes every job gossiped on the
 * network (including its own). Useful for a self-contained node or a small
 * deployment where you don't want to run two processes.
 *
 * Run: node --experimental-strip-types src/bin/aggregator-scraper.ts
 *
 * Environment: the union of the aggregator and scraper vars (see those
 * entrypoints + common.ts). KAL_DESCRIPTOR is required for the scraping half.
 */
import { readFileSync } from 'node:fs'
import { baseConfig, env, envBool, envInt, startNode, runUntilSignal, fail, errMsg } from './common.js'
import { runScrapePass } from './scrape-pass.js'
import { RateLimiter } from '../rate-limiter.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { log, flushLogs } from '../logger.js'
import type { PlatformDescriptor } from '../types.js'
import type { KalthraxiusNode } from '../p2p-node.js'

async function main(): Promise<void> {
  const cfg = baseConfig()

  // --- scraper config ---
  const descriptorPath = env('KAL_DESCRIPTOR')
  if (!descriptorPath) fail('KAL_DESCRIPTOR is required (path to a platform descriptor JSON)')
  const descriptor = JSON.parse(readFileSync(descriptorPath!, 'utf8')) as PlatformDescriptor
  const url = descriptor.baseUrl
  const scrapeIntervalMs = envInt('KAL_SCRAPE_MS', 5 * 60_000)
  const claimTtlMs = envInt('KAL_CLAIM_TTL_MS', 30 * 60_000)
  const stealth = envBool('KAL_STEALTH')

  // --- aggregator config ---
  const storePath = env('KAL_STORE_DB', 'aggregator-store.db')!
  const searchPath = env('KAL_SEARCH_DB', 'aggregator-search.db')!
  const platforms = (env('KAL_PLATFORMS', '') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const announceIntervalMs = envInt('KAL_ANNOUNCE_MS', 30_000)

  // --- shared node ---
  const node = await startNode(cfg)

  // --- aggregator half ---
  const store = new SqliteAggregatorStore(storePath)
  const search = new SqliteSearchIndex(searchPath)
  const aggregator = new AggregatorNode({
    node,
    store,
    search,
    platforms: platforms.length ? platforms : undefined,
    announceIntervalMs,
  })
  await aggregator.start()
  log.aggregator.info(`started — store=${storePath} jobs=${store.count()}`)

  // --- scraper half ---
  log.scraper.info(
    `platform=${descriptor.id} url=${url} stealth=${stealth} interval=${scrapeIntervalMs}ms rateLimit=${descriptor.rateLimit.requestsPerMinute}/min`,
  )
  await new Promise(r => setTimeout(r, 5_000)) // let gossip meshes form (needs several heartbeat rounds)

  const limiter = new RateLimiter()
  let scrapeTimer: NodeJS.Timeout | null = null
  let stopped = false
  const pass = async (): Promise<void> => {
    if (stopped) return
    try {
      const n = await runScrapePass(node as KalthraxiusNode, descriptor, url, { claimTtlMs, stealth, limiter })
      log.scraper.info(`pass complete — published ${n} job(s); indexed total=${store.count()}`)
    } catch (err) {
      log.scraper.error(`pass failed: ${errMsg(err)}`)
    }
  }
  await pass()
  scrapeTimer = setInterval(() => void pass(), scrapeIntervalMs)
  scrapeTimer.unref?.()

  await runUntilSignal(async () => {
    stopped = true
    if (scrapeTimer) clearInterval(scrapeTimer)
    await aggregator.stop()
    store.close()
    search.close()
    await node.stop()
    await flushLogs()
  })
}

main().catch(err => {
  log.error.error(String(err))
  process.exit(1)
})
