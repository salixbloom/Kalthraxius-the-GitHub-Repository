import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnConnectedCluster, stopAll } from './helpers/network.js'
import { publishJob } from '../gossip.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { getAggregatorAnnouncement } from '../aggregator/announce.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { RawJob } from '../types.js'

function makeJob(over: Partial<RawJob> = {}): RawJob {
  return {
    contentHash: `hash-${Math.random().toString(36).slice(2)}`,
    platformId: 'greenhouse',
    url: 'https://example.com/jobs/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django, PostgreSQL. $150k-$180k. 5+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: Date.now(),
    ...over,
  }
}

const PLATFORMS = ['greenhouse', 'lever', 'linkedin']

let tmpDir: string
let storePath: string
let searchPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-aggnode-'))
  storePath = join(tmpDir, 'store.db')
  searchPath = join(tmpDir, 'search.db')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

async function waitFor(pred: () => boolean, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!pred() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
  }
}

describe('AggregatorNode — gossip to index', () => {
  it('indexes all jobs gossiped by 3 scrapers across platforms', async () => {
    // node[0] is the aggregator; node[1..3] are scrapers.
    const nodes = await spawnConnectedCluster(4)
    const [aggNode, ...scrapers] = nodes as KalthraxiusNode[]
    const store = new SqliteAggregatorStore(storePath)
    const search = new SqliteSearchIndex(searchPath)
    const agg = new AggregatorNode({
      node: aggNode,
      store,
      search,
      platforms: PLATFORMS,
      announceIntervalMs: 60_000,
    })

    try {
      await agg.start()
      // Let subscriptions + gossip meshes form across all platform topics.
      await new Promise(r => setTimeout(r, 800))

      const jobs = [
        makeJob({ contentHash: 'g1', platformId: 'greenhouse', url: 'u1' }),
        makeJob({ contentHash: 'l1', platformId: 'lever', url: 'u2' }),
        makeJob({ contentHash: 'i1', platformId: 'linkedin', url: 'u3' }),
      ]
      // Each scraper publishes one platform's job.
      await publishJob(scrapers[0]!.services.pubsub, jobs[0]!)
      await publishJob(scrapers[1]!.services.pubsub, jobs[1]!)
      await publishJob(scrapers[2]!.services.pubsub, jobs[2]!)

      await waitFor(() => store.count() >= 3)
      expect(store.count()).toBe(3)
      expect(store.has('g1') && store.has('l1') && store.has('i1')).toBe(true)

      // Indexed for search too.
      const hits = search.search({ text: 'backend engineer' })
      expect(hits.length).toBeGreaterThanOrEqual(3)
    } finally {
      await agg.stop()
      store.close()
      search.close()
      await stopAll(nodes)
    }
  }, 25_000)

  it('dedups the same job gossiped by multiple scrapers', async () => {
    const nodes = await spawnConnectedCluster(3)
    const [aggNode, ...scrapers] = nodes as KalthraxiusNode[]
    const store = new SqliteAggregatorStore(storePath)
    const search = new SqliteSearchIndex(searchPath)
    const agg = new AggregatorNode({ node: aggNode, store, search, platforms: PLATFORMS, announceIntervalMs: 60_000 })

    try {
      await agg.start()
      await new Promise(r => setTimeout(r, 800))

      const job = makeJob({ contentHash: 'dup', platformId: 'greenhouse', url: 'u1' })
      await publishJob(scrapers[0]!.services.pubsub, job)
      await publishJob(scrapers[1]!.services.pubsub, job)

      await waitFor(() => store.count() >= 1)
      // Give any second copy time to (not) create a duplicate.
      await new Promise(r => setTimeout(r, 500))
      expect(store.count()).toBe(1)
    } finally {
      await agg.stop()
      store.close()
      search.close()
      await stopAll(nodes)
    }
  }, 25_000)
})

describe('AggregatorNode — DHT announcement matches DB state', () => {
  it('announces role:aggregator with stats equal to the store', async () => {
    const nodes = await spawnConnectedCluster(2)
    const [aggNode, other] = nodes as KalthraxiusNode[]
    const store = new SqliteAggregatorStore(storePath)
    const search = new SqliteSearchIndex(searchPath)
    const agg = new AggregatorNode({ node: aggNode, store, search, platforms: PLATFORMS, announceIntervalMs: 60_000 })

    try {
      // Seed the store directly, then announce.
      agg.ingest(makeJob({ contentHash: 'a', platformId: 'greenhouse', url: 'u1' }))
      agg.ingest(makeJob({ contentHash: 'b', platformId: 'lever', url: 'u2' }))
      await agg.start()
      await agg.announce()
      await new Promise(r => setTimeout(r, 500))

      const peerId = aggNode.peerId.toString()
      const announcement = await getAggregatorAnnouncement(other.services.dht, peerId)
      expect(announcement).not.toBeNull()
      expect(announcement!.role).toBe('aggregator')
      expect(announcement!.stats.totalJobs).toBe(store.stats().totalJobs)
      expect(announcement!.stats.byPlatform).toEqual(store.stats().byPlatform)
    } finally {
      await agg.stop()
      store.close()
      search.close()
      await stopAll(nodes)
    }
  }, 25_000)
})

describe('AggregatorNode — restart, no data loss', () => {
  it('recovers indexed jobs after a restart and keeps ingesting', async () => {
    // First run: ingest two jobs, then "crash" (close everything).
    {
      const store = new SqliteAggregatorStore(storePath)
      const search = new SqliteSearchIndex(searchPath)
      // No libp2p needed to prove store persistence; ingest directly.
      const nodes = await spawnConnectedCluster(1)
      const agg = new AggregatorNode({ node: nodes[0]!, store, search, platforms: PLATFORMS, announceIntervalMs: 60_000 })
      agg.ingest(makeJob({ contentHash: 'persist-1', url: 'u1' }))
      agg.ingest(makeJob({ contentHash: 'persist-2', url: 'u2' }))
      expect(store.count()).toBe(2)
      await agg.stop()
      store.close()
      search.close()
      await stopAll(nodes)
    }

    // Second run: reopen the same files — data survived.
    {
      const store = new SqliteAggregatorStore(storePath)
      const search = new SqliteSearchIndex(searchPath)
      const nodes = await spawnConnectedCluster(1)
      const agg = new AggregatorNode({ node: nodes[0]!, store, search, platforms: PLATFORMS, announceIntervalMs: 60_000 })
      try {
        expect(store.count()).toBe(2)
        expect(store.has('persist-1') && store.has('persist-2')).toBe(true)
        // Still ingesting after restart.
        agg.ingest(makeJob({ contentHash: 'persist-3', url: 'u3' }))
        expect(store.count()).toBe(3)
      } finally {
        await agg.stop()
        store.close()
        search.close()
        await stopAll(nodes)
      }
    }
  }, 25_000)
})
