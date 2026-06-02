import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobCache } from '../cache.js'
import type { RawJob } from '../types.js'

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    contentHash: 'abc123',
    platformId: 'greenhouse-stripe',
    url: 'https://boards.greenhouse.io/stripe/jobs/1',
    title: 'Senior Engineer',
    company: 'Stripe',
    location: 'Seattle, WA',
    description: 'We are looking for a senior engineer...',
    salary: '$180k–$220k',
    postedAt: '2026-05-01',
    scrapedAt: Date.now(),
    ...overrides,
  }
}

let tmpDir: string
let cache: JobCache

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-test-'))
  cache = new JobCache({
    dbPath: join(tmpDir, 'jobs.db'),
    maxSizeBytes: 50 * 1024 * 1024, // 50MB for most tests
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  })
})

afterEach(async () => {
  cache.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('JobCache.upsert', () => {
  it('inserts a new job and returns "inserted"', () => {
    expect(cache.upsert(makeJob())).toBe('inserted')
    expect(cache.count()).toBe(1)
  })

  it('returns "duplicate" for the same content hash', () => {
    const job = makeJob()
    cache.upsert(job)
    expect(cache.upsert(job)).toBe('duplicate')
    expect(cache.count()).toBe(1)
  })

  it('inserts two jobs with different hashes', () => {
    cache.upsert(makeJob({ contentHash: 'hash-a' }))
    cache.upsert(makeJob({ contentHash: 'hash-b' }))
    expect(cache.count()).toBe(2)
  })
})

describe('JobCache.get', () => {
  it('retrieves an inserted job by hash', () => {
    const job = makeJob()
    cache.upsert(job)
    const retrieved = cache.get(job.contentHash)
    expect(retrieved?.title).toBe('Senior Engineer')
    expect(retrieved?.company).toBe('Stripe')
  })

  it('returns undefined for an unknown hash', () => {
    expect(cache.get('nonexistent')).toBeUndefined()
  })
})

describe('TTL eviction', () => {
  it('evicts expired jobs on the next upsert', async () => {
    const ttlMs = 50
    const ttlCache = new JobCache({
      dbPath: join(tmpDir, 'ttl-jobs.db'),
      maxSizeBytes: 50 * 1024 * 1024,
      ttlMs,
    })


    try {
      // Insert a fresh job — survives because it just arrived
      ttlCache.upsert(makeJob({ contentHash: 'will-expire' }))
      expect(ttlCache.count()).toBe(1)

      // Let it expire
      await new Promise(r => setTimeout(r, ttlMs + 25))

      // Next upsert triggers eviction of the now-expired entry
      ttlCache.upsert(makeJob({ contentHash: 'fresh', scrapedAt: Date.now() }))

      expect(ttlCache.count()).toBe(1)
      expect(ttlCache.get('will-expire')).toBeUndefined()
      expect(ttlCache.get('fresh')).toBeDefined()
    } finally {
      ttlCache.close()
    }
  })
})

describe('Size cap eviction', () => {
  it('fires eviction on every upsert when cap is smaller than the DB', () => {
    // maxSizeBytes: 1 guarantees the DB (schema + WAL overhead alone is several KB)
    // is always over cap, so every upsert evicts all records.
    const tinyCache = new JobCache({
      dbPath: join(tmpDir, 'tiny-jobs.db'),
      maxSizeBytes: 1,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    })

    tinyCache.upsert(makeJob({ contentHash: 'job-1', scrapedAt: Date.now() }))
    // eviction runs after insert — DB still exceeds 1 byte, so record is removed
    expect(tinyCache.count()).toBe(0)

    tinyCache.close()
  })
})
