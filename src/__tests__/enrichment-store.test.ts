import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobCache } from '../cache.js'
import { EnrichmentStore } from '../enrichment-store.js'
import { migrate } from '../migrations.js'
import type { Enrichment, RawJob } from '../types.js'

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

function makeEnrichment(overrides: Partial<Enrichment> = {}): Enrichment {
  return {
    contentHash: 'abc123',
    salary: { value: { min: 180000, max: 220000, currency: 'USD', period: 'year' }, confidence: 0.9 },
    yoe: { value: 5, confidence: 0.8 },
    seniority: { value: 'senior', confidence: 0.95 },
    skills: [{ id: 'python', label: 'Python', confidence: 1 }],
    schemaVersion: 1,
    enrichedAt: Date.now(),
    ...overrides,
  }
}

let tmpDir: string
let cache: JobCache
let store: EnrichmentStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-enrich-'))
  cache = new JobCache({
    dbPath: join(tmpDir, 'jobs.db'),
    maxSizeBytes: 50 * 1024 * 1024,
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  })
  store = new EnrichmentStore(cache.connection)
})

afterEach(() => {
  cache.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('advances user_version to the number of migrations', () => {
    const v = cache.connection.pragma('user_version', { simple: true }) as number
    expect(v).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent — re-running migrate() is a no-op', () => {
    const before = cache.connection.pragma('user_version', { simple: true })
    migrate(cache.connection)
    const after = cache.connection.pragma('user_version', { simple: true })
    expect(after).toEqual(before)
  })
})

describe('EnrichmentStore round-trip', () => {
  it('stores and retrieves a full enrichment', () => {
    cache.upsert(makeJob())
    store.put(makeEnrichment())
    const got = store.get('abc123')
    expect(got?.salary.value?.min).toBe(180000)
    expect(got?.salary.value?.max).toBe(220000)
    expect(got?.yoe.value).toBe(5)
    expect(got?.seniority.value).toBe('senior')
    expect(got?.skills).toEqual([{ id: 'python', label: 'Python', confidence: 1 }])
  })

  it('represents a fully-null extraction (nothing found)', () => {
    cache.upsert(makeJob())
    store.put(
      makeEnrichment({
        salary: { value: null, confidence: 0 },
        yoe: { value: null, confidence: 0 },
        seniority: { value: null, confidence: 0 },
        skills: [],
      }),
    )
    const got = store.get('abc123')
    expect(got?.salary.value).toBeNull()
    expect(got?.yoe.value).toBeNull()
    expect(got?.seniority.value).toBeNull()
    expect(got?.skills).toEqual([])
  })

  it('upsert overwrites a prior enrichment (re-enrichment)', () => {
    cache.upsert(makeJob())
    store.put(makeEnrichment({ schemaVersion: 1 }))
    store.put(makeEnrichment({ schemaVersion: 2, yoe: { value: 7, confidence: 0.9 } }))
    expect(store.count()).toBe(1)
    expect(store.get('abc123')?.yoe.value).toBe(7)
    expect(store.get('abc123')?.schemaVersion).toBe(2)
  })
})

describe('pendingJobs (the migration/queue query)', () => {
  it('returns jobs with no enrichment', () => {
    cache.upsert(makeJob({ contentHash: 'j1' }))
    cache.upsert(makeJob({ contentHash: 'j2' }))
    expect(store.pendingCount(1)).toBe(2)
    expect(store.pendingJobs(10, 1).map(j => j.contentHash).sort()).toEqual(['j1', 'j2'])
  })

  it('excludes jobs enriched at the current version', () => {
    cache.upsert(makeJob({ contentHash: 'j1' }))
    store.put(makeEnrichment({ contentHash: 'j1', schemaVersion: 1 }))
    expect(store.pendingCount(1)).toBe(0)
  })

  it('re-includes jobs enriched at an older version (schema bump)', () => {
    cache.upsert(makeJob({ contentHash: 'j1' }))
    store.put(makeEnrichment({ contentHash: 'j1', schemaVersion: 1 }))
    // After bumping the current version to 2, the v1 row is stale again.
    expect(store.pendingCount(2)).toBe(1)
    expect(store.pendingJobs(10, 2)[0]?.contentHash).toBe('j1')
  })

  it('cascades: deleting a job removes its enrichment', () => {
    cache.upsert(makeJob({ contentHash: 'j1' }))
    store.put(makeEnrichment({ contentHash: 'j1' }))
    cache.connection.prepare('DELETE FROM jobs WHERE content_hash = ?').run('j1')
    expect(store.get('j1')).toBeUndefined()
    expect(store.count()).toBe(0)
  })
})
