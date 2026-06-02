import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobCache } from '../cache.js'
import { EnrichmentStore } from '../enrichment-store.js'
import { EnrichmentWorker } from '../enrichment/worker.js'
import { runMigration } from '../enrichment/migration-job.js'
import type { RawJob } from '../types.js'

function makeJob(i: number): RawJob {
  return {
    contentHash: `job-${i}`,
    platformId: 'greenhouse',
    url: `https://example.com/jobs/${i}`,
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django, PostgreSQL. $150k-$180k. 5+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: Date.now() + i,
  }
}

let tmpDir: string
let cache: JobCache
let store: EnrichmentStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-migjob-'))
  cache = new JobCache({
    dbPath: join(tmpDir, 'jobs.db'),
    maxSizeBytes: 500 * 1024 * 1024,
    ttlMs: 365 * 24 * 60 * 60 * 1000,
  })
  store = new EnrichmentStore(cache.connection)
})

afterEach(() => {
  cache.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('schema migration background job (Phase 8 gate)', () => {
  it('1000 records at v0, bump version, all reach current with no corruption', async () => {
    const N = 1000
    for (let i = 0; i < N; i++) cache.upsert(makeJob(i))

    // Enrich all at v1 (the current version).
    const v1 = new EnrichmentWorker(cache.connection, { schemaVersion: 1 })
    expect(v1.drain()).toBe(N)
    expect(store.count()).toBe(N)

    // Bump to v2 → every record is now stale. Run the batched migration job.
    let lastProgress = 0
    const report = await runMigration(cache.connection, {
      batchSize: 100,
      schemaVersion: 2,
      onProgress: migrated => {
        lastProgress = migrated
      },
    })

    expect(report.fromPending).toBe(N)
    expect(report.migrated).toBe(N)
    expect(lastProgress).toBe(N)

    // No corruption: every record now at v2, still exactly N rows, content intact.
    expect(store.count()).toBe(N)
    expect(store.pendingCount(2)).toBe(0)
    const sample = store.get('job-0')
    expect(sample?.schemaVersion).toBe(2)
    expect(sample?.salary.value).toMatchObject({ min: 150000, max: 180000 })
    expect(sample?.seniority.value).toBe('senior')
  })

  it('is resumable: a partial run completes on the next invocation', async () => {
    for (let i = 0; i < 50; i++) cache.upsert(makeJob(i))
    new EnrichmentWorker(cache.connection, { schemaVersion: 1 }).drain()

    // Simulate a partial migration by processing only some batches manually.
    const worker = new EnrichmentWorker(cache.connection, { batchSize: 10, schemaVersion: 2 })
    worker.processBatch() // 10 of 50
    worker.processBatch() // 20 of 50
    expect(store.pendingCount(2)).toBe(30)

    // The migration job picks up the remaining 30 with no double-processing.
    const report = await runMigration(cache.connection, { batchSize: 10, schemaVersion: 2 })
    expect(report.migrated).toBe(30)
    expect(store.pendingCount(2)).toBe(0)
    expect(store.count()).toBe(50)
  })

  it('no-op when nothing is stale', async () => {
    for (let i = 0; i < 10; i++) cache.upsert(makeJob(i))
    new EnrichmentWorker(cache.connection, { schemaVersion: 1 }).drain()
    const report = await runMigration(cache.connection, { schemaVersion: 1 })
    expect(report.migrated).toBe(0)
  })
})
