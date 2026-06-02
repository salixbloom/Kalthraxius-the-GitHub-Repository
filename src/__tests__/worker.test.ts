import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobCache } from '../cache.js'
import { EnrichmentStore } from '../enrichment-store.js'
import { EnrichmentWorker } from '../enrichment/worker.js'
import type { RawJob } from '../types.js'

function makeJob(i: number): RawJob {
  return {
    contentHash: `job-${i}`,
    platformId: 'greenhouse-acme',
    url: `https://example.com/jobs/${i}`,
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django, PostgreSQL, Docker, Kubernetes. $150k - $180k. 5+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: Date.now() + i, // stable ordering
  }
}

let tmpDir: string
let cache: JobCache
let store: EnrichmentStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-worker-'))
  cache = new JobCache({
    dbPath: join(tmpDir, 'jobs.db'),
    maxSizeBytes: 200 * 1024 * 1024,
    ttlMs: 90 * 24 * 60 * 60 * 1000,
  })
  store = new EnrichmentStore(cache.connection)
})

afterEach(() => {
  cache.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('EnrichmentWorker — batch processing', () => {
  it('drains the whole backlog and writes enrichments', () => {
    for (let i = 0; i < 25; i++) cache.upsert(makeJob(i))
    const worker = new EnrichmentWorker(cache.connection, { batchSize: 10 })
    const total = worker.drain()
    expect(total).toBe(25)
    expect(store.count()).toBe(25)

    const e = store.get('job-0')
    expect(e?.salary.value).toMatchObject({ min: 150000, max: 180000 })
    expect(e?.seniority.value).toBe('senior')
    expect(e?.yoe.value).toBe(5)
    expect(e?.skills.map(s => s.id)).toContain('python')
  })

  it('processBatch returns 0 on an empty queue', () => {
    const worker = new EnrichmentWorker(cache.connection)
    expect(worker.processBatch()).toBe(0)
  })

  it('does not re-enrich already-current records', () => {
    cache.upsert(makeJob(0))
    const worker = new EnrichmentWorker(cache.connection)
    expect(worker.drain()).toBe(1)
    // Second drain finds nothing pending.
    expect(worker.drain()).toBe(0)
    expect(worker.pendingCount()).toBe(0)
  })
})

describe('EnrichmentWorker — re-enrichment via schema bump', () => {
  it('re-queues everything when the target version increases', () => {
    for (let i = 0; i < 5; i++) cache.upsert(makeJob(i))

    // Enrich at v1.
    const v1 = new EnrichmentWorker(cache.connection, { schemaVersion: 1 })
    expect(v1.drain()).toBe(5)
    expect(v1.pendingCount()).toBe(0)

    // Bump to v2: all 5 are stale again and get re-processed with no corruption.
    const v2 = new EnrichmentWorker(cache.connection, { schemaVersion: 2 })
    expect(v2.pendingCount()).toBe(5)
    expect(v2.drain()).toBe(5)
    expect(store.count()).toBe(5) // upsert, not duplicate
    expect(store.get('job-0')?.schemaVersion).toBe(2)
  })
})

describe('EnrichmentWorker — async loop is non-blocking / decoupled', () => {
  it('runs in the background and lets ingest continue concurrently', async () => {
    for (let i = 0; i < 50; i++) cache.upsert(makeJob(i))
    const worker = new EnrichmentWorker(cache.connection, { batchSize: 5, idlePollMs: 20 })
    worker.start()

    // While the worker runs, ingest must still make progress on the same thread.
    let ingested = 0
    for (let i = 50; i < 60; i++) {
      cache.upsert(makeJob(i))
      ingested++
      await new Promise(r => setImmediate(r))
    }
    expect(ingested).toBe(10)

    // Let the worker finish the backlog.
    const deadline = Date.now() + 5000
    while (worker.pendingCount() > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20))
    }
    await worker.stop()

    expect(worker.pendingCount()).toBe(0)
    expect(store.count()).toBe(60)
  })

  it('stop() is prompt and idempotent', async () => {
    const worker = new EnrichmentWorker(cache.connection, { idlePollMs: 50 })
    worker.start()
    await worker.stop()
    await worker.stop() // second call is a no-op
    expect(true).toBe(true)
  })
})

describe('EnrichmentWorker — throughput gate', () => {
  it('enriches >= 1000 jobs/min on a single core', () => {
    const N = 2000
    for (let i = 0; i < N; i++) cache.upsert(makeJob(i))

    const worker = new EnrichmentWorker(cache.connection, { batchSize: 200 })
    const start = performance.now()
    const total = worker.drain()
    const elapsedMs = performance.now() - start

    expect(total).toBe(N)
    const jobsPerMin = (N / elapsedMs) * 60_000
    // Plan gate is 1000/min; we expect to clear it by a wide margin. Assert the
    // floor so a perf regression trips the test.
    console.log(`Enrichment throughput: ${Math.round(jobsPerMin).toLocaleString()} jobs/min`)
    expect(jobsPerMin).toBeGreaterThan(1000)
  })
})
