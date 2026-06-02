import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnConnectedCluster, stopAll } from './helpers/network.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { QueryClient } from '../query/client.js'
import { QueryServer } from '../query/server.js'
import { enrichJob } from '../enrichment/enrich.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { RawJob } from '../types.js'
import type { ScoredHit } from '../query/types.js'

const PLATFORMS = ['greenhouse', 'lever', 'linkedin']

function makeJob(hash: string, over: Partial<RawJob> = {}): RawJob {
  return {
    contentHash: hash,
    platformId: 'greenhouse',
    url: `https://example.com/${hash}`,
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django, PostgreSQL. $150k-$180k. 3+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: Date.now(),
    ...over,
  }
}

let tmpDir: string
let cleanups: Array<() => void | Promise<void>>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-fanout-'))
  cleanups = []
})

afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Spin up an AggregatorNode on the given libp2p node, seeded with jobs. */
async function makeAggregator(node: KalthraxiusNode, label: string, jobs: RawJob[]): Promise<AggregatorNode> {
  const store = new SqliteAggregatorStore(join(tmpDir, `${label}-store.db`))
  const search = new SqliteSearchIndex(join(tmpDir, `${label}-search.db`))
  const agg = new AggregatorNode({ node, store, search, platforms: PLATFORMS, announceIntervalMs: 60_000 })
  for (const j of jobs) agg.ingest(j)
  await agg.start()
  cleanups.push(async () => {
    await agg.stop()
    store.close()
    search.close()
  })
  return agg
}

describe('fan-out — dedup by content hash', () => {
  it('the same job seeded on 3 aggregators returns exactly once', async () => {
    const nodes = await spawnConnectedCluster(4)
    cleanups.push(() => stopAll(nodes))
    const [clientNode, a1, a2, a3] = nodes as KalthraxiusNode[]

    // Same job (same hash) on all three aggregators, plus a unique one each.
    const shared = makeJob('shared', { url: 'u-shared' })
    await makeAggregator(a1, 'a1', [shared, makeJob('only-1', { url: 'u1' })])
    await makeAggregator(a2, 'a2', [shared, makeJob('only-2', { url: 'u2' })])
    await makeAggregator(a3, 'a3', [shared, makeJob('only-3', { url: 'u3' })])

    const client = new QueryClient(clientNode)
    const result = await client.query(
      { stack: ['python', 'django'] },
      { peers: [a1.peerId, a2.peerId, a3.peerId] },
    )

    const hashes = result.hits.map(h => h.contentHash)
    expect(hashes.filter(h => h === 'shared')).toHaveLength(1)
    expect(new Set(hashes)).toEqual(new Set(['shared', 'only-1', 'only-2', 'only-3']))
    expect(result.answered).toHaveLength(3)
    expect(result.failed).toHaveLength(0)
  }, 30_000)
})

describe('fan-out — failover', () => {
  it('a dead aggregator does not prevent results from the live ones', async () => {
    const nodes = await spawnConnectedCluster(3)
    cleanups.push(() => stopAll(nodes))
    const [clientNode, a1, a2] = nodes as KalthraxiusNode[]

    await makeAggregator(a1, 'a1', [makeJob('live-1', { url: 'u1' })])
    await makeAggregator(a2, 'a2', [makeJob('live-2', { url: 'u2' })])

    // Stop a2 to simulate a dead aggregator mid-session.
    await a2.stop()

    const client = new QueryClient(clientNode)
    const result = await client.query(
      { stack: ['python'] },
      { peers: [a1.peerId, a2.peerId], peerTimeoutMs: 2_000 },
    )

    expect(result.hits.map(h => h.contentHash)).toContain('live-1')
    expect(result.answered).toContain(a1.peerId.toString())
    expect(result.failed).toContain(a2.peerId.toString())
  }, 30_000)
})

describe('fan-out — DHT discovery', () => {
  it('client discovers aggregators via the rendezvous and queries them', async () => {
    const nodes = await spawnConnectedCluster(3)
    cleanups.push(() => stopAll(nodes))
    const [clientNode, a1, a2] = nodes as KalthraxiusNode[]

    await makeAggregator(a1, 'a1', [makeJob('disc-1', { url: 'u1' })])
    await makeAggregator(a2, 'a2', [makeJob('disc-2', { url: 'u2' })])

    // Give provider records time to propagate through the DHT.
    await new Promise(r => setTimeout(r, 1500))

    const client = new QueryClient(clientNode)
    // No explicit peers → forces DHT discovery.
    const result = await client.query({ stack: ['python'] }, { k: 6 })

    // At least one aggregator should be discovered and answer.
    expect(result.answered.length).toBeGreaterThanOrEqual(1)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
  }, 30_000)
})

describe('SSE streaming — first result latency', () => {
  it('streams the first hit quickly and a done event with summary', async () => {
    const nodes = await spawnConnectedCluster(3)
    cleanups.push(() => stopAll(nodes))
    const [clientNode, a1, a2] = nodes as KalthraxiusNode[]

    await makeAggregator(a1, 'a1', [makeJob('sse-1', { url: 'u1' })])
    await makeAggregator(a2, 'a2', [makeJob('sse-2', { url: 'u2' })])

    const server = new QueryServer(clientNode, { peers: [a1.peerId, a2.peerId] })
    const port = await server.listen(0)
    cleanups.push(() => server.close())

    const body = JSON.stringify({ stack: ['python'] })
    const start = performance.now()
    const res = await fetch(`http://127.0.0.1:${port}/query/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.ok).toBe(true)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let firstHitAt = 0
    let buffer = ''
    const events: string[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (!firstHitAt && buffer.includes('event: hit')) {
        firstHitAt = performance.now() - start
      }
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      events.push(...parts)
      if (events.some(e => e.includes('event: done'))) break
    }

    const hitEvents = events.filter(e => e.includes('event: hit'))
    expect(hitEvents.length).toBeGreaterThanOrEqual(1)
    expect(events.some(e => e.includes('event: done'))).toBe(true)
    // First hit should arrive well under a generous bound (target <200ms; allow
    // headroom for CI). The point is it doesn't wait for slow peers.
    expect(firstHitAt).toBeLessThan(2_000)
  }, 30_000)
})

describe('REST /query', () => {
  it('returns merged JSON results', async () => {
    const nodes = await spawnConnectedCluster(2)
    cleanups.push(() => stopAll(nodes))
    const [clientNode, a1] = nodes as KalthraxiusNode[]

    await makeAggregator(a1, 'a1', [makeJob('rest-1', { url: 'u1' })])

    const server = new QueryServer(clientNode, { peers: [a1.peerId] })
    const port = await server.listen(0)
    cleanups.push(() => server.close())

    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack: ['python'], yoeMax: 5 }),
    })
    expect(res.ok).toBe(true)
    const json = (await res.json()) as { hits: ScoredHit[] }
    expect(json.hits.map(h => h.contentHash)).toContain('rest-1')
  }, 30_000)
})
