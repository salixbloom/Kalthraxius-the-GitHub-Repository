import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { enrichJob } from '../enrichment/enrich.js'
import type { IndexedJob } from '../aggregator/store.js'
import type { RawJob } from '../types.js'

function rawJob(over: Partial<RawJob> = {}): RawJob {
  return {
    contentHash: 'h1',
    platformId: 'greenhouse',
    url: 'https://example.com/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Python, Django, PostgreSQL. $150k - $180k. 5+ years of experience.',
    salary: '$150,000 - $180,000',
    postedAt: '2026-05-01',
    scrapedAt: 1_700_000_000_000,
    ...over,
  }
}

function indexed(over: Partial<RawJob> = {}): IndexedJob {
  const job = rawJob(over)
  return { job, enrichment: enrichJob(job) }
}

let tmpDir: string
let dbPath: string
let store: SqliteAggregatorStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-agg-'))
  dbPath = join(tmpDir, 'agg.db')
  store = new SqliteAggregatorStore(dbPath)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SqliteAggregatorStore — dedup by content hash', () => {
  it('inserts once, updates on repeat', () => {
    expect(store.upsert(indexed({ contentHash: 'a' }))).toBe('inserted')
    expect(store.upsert(indexed({ contentHash: 'a' }))).toBe('updated')
    expect(store.count()).toBe(1)
  })

  it('round-trips raw + enrichment', () => {
    store.upsert(indexed({ contentHash: 'a' }))
    const got = store.get('a')
    expect(got?.job.title).toBe('Senior Backend Engineer')
    expect(got?.enrichment.seniority.value).toBe('senior')
    expect(got?.enrichment.salary.value).toMatchObject({ min: 150000, max: 180000 })
  })

  it('allHashes returns every held hash', () => {
    store.upsert(indexed({ contentHash: 'a' }))
    store.upsert(indexed({ contentHash: 'b', url: 'https://example.com/2' }))
    expect(store.allHashes().sort()).toEqual(['a', 'b'])
  })
})

describe('SqliteAggregatorStore — stats match DB state', () => {
  it('reports totals, per-platform counts, salary null rate, newest', () => {
    store.upsert(indexed({ contentHash: 'a', platformId: 'greenhouse', scrapedAt: 100 }))
    store.upsert(indexed({ contentHash: 'b', platformId: 'lever', scrapedAt: 300, salary: null, description: 'No pay listed. React.' }))
    store.upsert(indexed({ contentHash: 'c', platformId: 'lever', scrapedAt: 200 }))

    const s = store.stats()
    expect(s.totalJobs).toBe(3)
    expect(s.byPlatform).toEqual({ greenhouse: 1, lever: 2 })
    expect(s.newestScrapedAt).toBe(300)
    // 'b' has no salary text → null; others extract → 1/3.
    expect(s.salaryNullRate).toBeCloseTo(1 / 3, 5)
  })

  it('empty store has zeroed stats', () => {
    const s = store.stats()
    expect(s.totalJobs).toBe(0)
    expect(s.salaryNullRate).toBe(0)
    expect(s.newestScrapedAt).toBe(0)
  })
})

describe('persistence / restart — no data loss', () => {
  it('recovers all jobs after reopening the same db file', () => {
    store.upsert(indexed({ contentHash: 'a' }))
    store.upsert(indexed({ contentHash: 'b', url: 'https://example.com/2' }))
    store.close()

    const reopened = new SqliteAggregatorStore(dbPath)
    try {
      expect(reopened.count()).toBe(2)
      expect(reopened.get('a')?.enrichment.seniority.value).toBe('senior')
    } finally {
      reopened.close()
    }
  })
})

describe('SqliteSearchIndex — FTS', () => {
  let searchPath: string
  let search: SqliteSearchIndex

  beforeEach(() => {
    searchPath = join(tmpDir, 'search.db')
    search = new SqliteSearchIndex(searchPath)
  })
  afterEach(() => search.close())

  it('indexes and finds by free text', () => {
    search.index(indexed({ contentHash: 'a' }))
    const hits = search.search({ text: 'backend engineer' })
    expect(hits.map(h => h.contentHash)).toContain('a')
  })

  it('is idempotent by hash (re-index does not duplicate)', () => {
    const j = indexed({ contentHash: 'a' })
    search.index(j)
    search.index(j)
    expect(search.count()).toBe(1)
  })

  it('filters by platform', () => {
    search.index(indexed({ contentHash: 'a', platformId: 'greenhouse' }))
    search.index(indexed({ contentHash: 'b', platformId: 'lever', url: 'https://example.com/2' }))
    const hits = search.search({ text: 'engineer', platformId: 'lever' })
    expect(hits.map(h => h.contentHash)).toEqual(['b'])
  })

  it('remove deletes from the index', () => {
    search.index(indexed({ contentHash: 'a' }))
    search.remove('a')
    expect(search.search({ text: 'engineer' })).toEqual([])
  })

  it('malicious FTS operators in query are neutralised (no throw)', () => {
    search.index(indexed({ contentHash: 'a' }))
    expect(() => search.search({ text: 'engineer OR (NEAR' })).not.toThrow()
  })
})
