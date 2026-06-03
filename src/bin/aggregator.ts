/**
 * Aggregator node entrypoint.
 *
 * Subscribes to every platform topic, verifies + enriches + indexes gossiped
 * jobs, and announces itself on the DHT. Persists to SQLite so a restart
 * recovers all jobs.
 *
 * Run: node --experimental-strip-types src/bin/aggregator.ts
 *
 * Environment (plus the base vars in common.ts):
 *   KAL_STORE_DB        aggregator store path (default ./aggregator-store.db)
 *   KAL_SEARCH_DB       FTS search index path (default ./aggregator-search.db)
 *   KAL_PLATFORMS       comma-separated platform ids (default: data/platforms.json)
 *   KAL_ANNOUNCE_MS     announce/bloom cadence in ms (default 30000)
 */
import { baseConfig, env, envInt, startNode, runUntilSignal } from './common.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'

async function main(): Promise<void> {
  const cfg = baseConfig()
  const storePath = env('KAL_STORE_DB', 'aggregator-store.db')!
  const searchPath = env('KAL_SEARCH_DB', 'aggregator-search.db')!
  const platforms = (env('KAL_PLATFORMS', '') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const announceIntervalMs = envInt('KAL_ANNOUNCE_MS', 30_000)

  const node = await startNode(cfg)
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

  console.log(`[aggregator] started — store=${storePath} search=${searchPath}`)
  console.log(`[aggregator] subscribed platforms: ${(platforms.length ? platforms : ['<registry>']).join(', ')}`)
  console.log(`[aggregator] indexed jobs at boot: ${store.count()}`)

  // Periodic heartbeat so operators can see it's alive and growing.
  const heartbeat = setInterval(() => {
    const s = store.stats()
    console.log(
      `[aggregator] jobs=${s.totalJobs} rejected=${aggregator.rejected} salaryNull=${(s.salaryNullRate * 100).toFixed(1)}%`,
    )
  }, 60_000)
  heartbeat.unref?.()

  await runUntilSignal(async () => {
    clearInterval(heartbeat)
    await aggregator.stop()
    store.close()
    search.close()
    await node.stop()
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
