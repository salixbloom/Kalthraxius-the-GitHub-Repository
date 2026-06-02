import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnConnectedCluster, stopAll } from './helpers/network.js'
import { publishJob } from '../gossip.js'
import { publishFeedback, subscribeToFeedback, FeedbackLedger } from '../trust/feedback.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { contentHash } from '../job-hash.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { RawJob } from '../types.js'
import type { FeedbackSignal } from '../trust/feedback.js'

let tmpDir: string
let cleanups: Array<() => void | Promise<void>>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-trustgossip-'))
  cleanups = []
})

afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  rmSync(tmpDir, { recursive: true, force: true })
})

function realJob(over: Partial<RawJob> = {}): RawJob {
  const base: RawJob = {
    contentHash: '',
    platformId: 'greenhouse',
    url: 'https://example.com/jobs/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django. $150k-$180k. 3+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: Date.now(),
    ...over,
  }
  return { ...base, contentHash: contentHash(base) }
}

describe('feedback gossip — appears within 2 cycles (Phase 7 gate)', () => {
  it('a feedback signal from one client reaches another peer and accumulates', async () => {
    const [client, watcher] = (await spawnConnectedCluster(2)) as KalthraxiusNode[]
    cleanups.push(() => stopAll([client, watcher]))

    const ledger = new FeedbackLedger()
    const unsub = subscribeToFeedback(watcher.services.pubsub, sig => ledger.record(sig))
    cleanups.push(unsub)

    // Let the gossipsub mesh form on the feedback topic.
    await new Promise(r => setTimeout(r, 600))

    const signal: FeedbackSignal = {
      jobId: 'job-xyz',
      reason: 'expired',
      servedBy: 'agg-A',
      at: Date.now(),
    }
    await publishFeedback(client.services.pubsub, signal)

    // Wait up to ~2 gossip cycles (heartbeatInterval is 500ms in this stack).
    const deadline = Date.now() + 4_000
    while (ledger.negativeCount('agg-A') === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }

    expect(ledger.negativeCount('agg-A')).toBe(1)
    expect(ledger.feedbackScore('agg-A')).toBeLessThan(1)
  }, 20_000)
})

describe('content-hash integrity at ingest over gossip (Phase 7 gate)', () => {
  it('a fabricated job gossiped to an aggregator is rejected, a clean one is stored', async () => {
    const [aggNode, scraper] = (await spawnConnectedCluster(2)) as KalthraxiusNode[]
    cleanups.push(() => stopAll([aggNode, scraper]))

    const store = new SqliteAggregatorStore(join(tmpDir, 'store.db'))
    const search = new SqliteSearchIndex(join(tmpDir, 'search.db'))
    // verifyContentHash defaults to true — this is the gate under test.
    const agg = new AggregatorNode({
      node: aggNode,
      store,
      search,
      platforms: ['greenhouse'],
      announceIntervalMs: 60_000,
    })
    cleanups.push(async () => {
      await agg.stop()
      store.close()
      search.close()
    })
    await agg.start()
    await new Promise(r => setTimeout(r, 600))

    // Clean job: hash matches content.
    const clean = realJob({ url: 'https://example.com/clean' })
    // Tampered job: content altered AFTER hashing (hash no longer matches).
    const tampered = { ...realJob({ url: 'https://example.com/evil' }), salary: '$1 - $1' }

    await publishJob(scraper.services.pubsub, clean)
    await publishJob(scraper.services.pubsub, tampered)

    // Wait for the clean one to land.
    const deadline = Date.now() + 5_000
    while (!store.has(clean.contentHash) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    // Give the tampered one equal opportunity to (wrongly) land.
    await new Promise(r => setTimeout(r, 500))

    expect(store.has(clean.contentHash)).toBe(true)
    expect(store.has(tampered.contentHash)).toBe(false)
    expect(agg.rejected).toBeGreaterThanOrEqual(1)
  }, 20_000)
})
