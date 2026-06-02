import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashJob, contentHash, locationHash, verifyIntegrity } from '../job-hash.js'
import { reputationScore, ReputationTracker } from '../trust/reputation.js'
import { scoreConsistency, flagOutliers } from '../trust/consistency.js'
import { probeStaleness } from '../trust/staleness.js'
import { FeedbackLedger } from '../trust/feedback.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { enrichJob } from '../enrichment/enrich.js'
import type { RawJob } from '../types.js'
import type { AggregatorAnnouncement } from '../aggregator/announce.js'
import type { UrlStatus } from '../trust/staleness.js'

function rawJob(over: Partial<RawJob> = {}): RawJob {
  const base: RawJob = {
    contentHash: '',
    platformId: 'greenhouse',
    url: 'https://example.com/jobs/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build things with Python.',
    salary: '$150k - $180k',
    postedAt: '2026-05-01',
    scrapedAt: 1_700_000_000_000,
    ...over,
  }
  return { ...base, contentHash: contentHash(base) }
}

describe('job-hash — canonical identity', () => {
  it('locationHash groups copies of the same listing regardless of content', () => {
    const a = rawJob({ title: 'Senior Engineer' })
    const b = rawJob({ title: 'COMPLETELY DIFFERENT' })
    // Same platform+url → same locationHash...
    expect(locationHash(a.platformId, a.url)).toBe(locationHash(b.platformId, b.url))
    // ...but different content → different contentHash (tamper-detectable).
    expect(a.contentHash).not.toBe(b.contentHash)
  })

  it('contentHash is stable across scrapedAt (two honest scrapers agree)', () => {
    const t1 = rawJob({ scrapedAt: 1 })
    const t2 = rawJob({ scrapedAt: 999_999 })
    expect(t1.contentHash).toBe(t2.contentHash)
  })

  it('hashJob returns both parts', () => {
    const id = hashJob(rawJob())
    expect(id.locationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(id.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('field boundaries are injection-resistant', () => {
    // Moving text across the title/company boundary must change the hash.
    const a = rawJob({ title: 'AB', company: 'CD' })
    const b = rawJob({ title: 'ABC', company: 'D' })
    expect(a.contentHash).not.toBe(b.contentHash)
  })
})

describe('verifyIntegrity — tamper detection (Phase 7 gate)', () => {
  it('a clean job verifies', () => {
    expect(verifyIntegrity(rawJob()).ok).toBe(true)
  })

  it('corrupting any content field is detected as a hash mismatch', () => {
    const job = rawJob()
    const tampered = { ...job, salary: '$999k - $999k' } // content changed, hash not
    const result = verifyIntegrity(tampered)
    expect(result.ok).toBe(false)
    expect(result.expected).toBe(job.contentHash)
    expect(result.actual).not.toBe(job.contentHash)
  })
})

describe('reputationScore — integrity dominant', () => {
  it('perfect signals score 1', () => {
    expect(
      reputationScore({ integrityPassRate: 1, stalenessRate: 0, statConsistency: 1, feedbackScore: 1 }),
    ).toBeCloseTo(1, 5)
  })

  it('an integrity failure hurts more than any other single signal', () => {
    const badIntegrity = reputationScore({ integrityPassRate: 0, stalenessRate: 0, statConsistency: 1, feedbackScore: 1 })
    const badStaleness = reputationScore({ integrityPassRate: 1, stalenessRate: 1, statConsistency: 1, feedbackScore: 1 })
    const badConsistency = reputationScore({ integrityPassRate: 1, stalenessRate: 0, statConsistency: 0, feedbackScore: 1 })
    const badFeedback = reputationScore({ integrityPassRate: 1, stalenessRate: 0, statConsistency: 1, feedbackScore: 0 })
    expect(badIntegrity).toBeLessThan(badStaleness)
    expect(badIntegrity).toBeLessThan(badConsistency)
    expect(badIntegrity).toBeLessThan(badFeedback)
  })

  it('ReputationTracker accumulates integrity observations', () => {
    const t = new ReputationTracker()
    for (let i = 0; i < 9; i++) t.recordIntegrity('agg-A', true)
    t.recordIntegrity('agg-A', false) // 9/10 pass
    for (let i = 0; i < 10; i++) t.recordIntegrity('agg-B', true) // 10/10

    expect(t.signals('agg-A').integrityPassRate).toBeCloseTo(0.9, 5)
    expect(t.score('agg-B')).toBeGreaterThan(t.score('agg-A'))
  })
})

describe('cross-aggregator consistency', () => {
  function ann(peerId: string, salaryNullRate: number): AggregatorAnnouncement {
    return {
      role: 'aggregator',
      peerId,
      stats: { totalJobs: 100, byPlatform: {}, salaryNullRate, newestScrapedAt: 0 },
      announcedAt: Date.now(),
    }
  }

  it('an outlier null-rate scores lower consistency than the consensus', () => {
    const reports = scoreConsistency([ann('a', 0.1), ann('b', 0.12), ann('c', 0.11), ann('liar', 0.9)])
    const liar = reports.find(r => r.peerId === 'liar')!
    const honest = reports.find(r => r.peerId === 'a')!
    expect(liar.consistency).toBeLessThan(honest.consistency)
  })

  it('flagOutliers names the divergent aggregator', () => {
    const flagged = flagOutliers([ann('a', 0.1), ann('b', 0.12), ann('c', 0.11), ann('liar', 0.9)])
    expect(flagged).toEqual(['liar'])
  })

  it('fewer than 3 aggregators → neutral consistency (thin evidence)', () => {
    const reports = scoreConsistency([ann('a', 0.1), ann('b', 0.9)])
    expect(reports.every(r => r.consistency === 1)).toBe(true)
  })
})

describe('staleness probe (Phase 7 gate)', () => {
  it('100 jobs with 30 dead URLs reports ~30% staleness', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-stale-'))
    const store = new SqliteAggregatorStore(join(tmpDir, 'store.db'))
    try {
      // 100 old jobs; deterministically mark 30 of them dead by url suffix.
      const dead = new Set<string>()
      const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days old
      for (let i = 0; i < 100; i++) {
        const url = `https://example.com/job/${i}`
        if (i % 10 < 3) dead.add(url) // 30%
        const job = rawJob({ url, contentHash: `h${i}`, scrapedAt: oldTs + i })
        store.upsert({ job, enrichment: enrichJob(job) })
      }

      const check = async (url: string): Promise<UrlStatus> => (dead.has(url) ? 'dead' : 'alive')
      const report = await probeStaleness(store, check, { sampleSize: 100, minAgeMs: 7 * 24 * 60 * 60 * 1000 })

      expect(report.sampled).toBe(100)
      expect(report.stalenessRate).toBeCloseTo(0.3, 1)
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('a flaky checker (throws) does not inflate the dead rate', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kalthraxius-stale2-'))
    const store = new SqliteAggregatorStore(join(tmpDir, 'store.db'))
    try {
      const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000
      for (let i = 0; i < 10; i++) {
        const job = rawJob({ url: `https://x/${i}`, contentHash: `h${i}`, scrapedAt: oldTs + i })
        store.upsert({ job, enrichment: enrichJob(job) })
      }
      const check = async (url: string): Promise<UrlStatus> => {
        if (url.endsWith('/0')) throw new Error('network blip')
        return 'alive'
      }
      const report = await probeStaleness(store, check, { sampleSize: 10, minAgeMs: 1 })
      // 1 indeterminate skipped → sampled 9, 0 dead.
      expect(report.sampled).toBe(9)
      expect(report.dead).toBe(0)
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('FeedbackLedger', () => {
  it('accumulates distinct complaints and decays feedback score', () => {
    const ledger = new FeedbackLedger()
    const base = { servedBy: 'agg-A', at: Date.now() } as const
    ledger.record({ ...base, jobId: 'j1', reason: 'expired' })
    ledger.record({ ...base, jobId: 'j2', reason: 'spam' })
    // Duplicate (same job + reason) counts once.
    ledger.record({ ...base, jobId: 'j1', reason: 'expired' })

    expect(ledger.negativeCount('agg-A')).toBe(2)
    expect(ledger.feedbackScore('agg-A')).toBeLessThan(1)
    expect(ledger.feedbackScore('agg-clean')).toBe(1)
  })
})

describe('broken-regex aggregator degrades vs healthy (Phase 7 gate)', () => {
  it('an aggregator with a high salary null-rate scores lower consistency', () => {
    // A broken salary regex shows up as an anomalous salaryNullRate vs peers.
    function ann(peerId: string, salaryNullRate: number): AggregatorAnnouncement {
      return {
        role: 'aggregator',
        peerId,
        stats: { totalJobs: 100, byPlatform: {}, salaryNullRate, newestScrapedAt: 0 },
        announcedAt: Date.now(),
      }
    }
    // Healthy peers extract salary well (~8% null); the broken one nulls ~95%.
    const reports = scoreConsistency([ann('h1', 0.08), ann('h2', 0.07), ann('broken', 0.95)])
    const tracker = new ReputationTracker()
    for (const r of reports) tracker.setConsistency(r.peerId, r.consistency)
    // Both clean on integrity; the broken one loses on consistency.
    tracker.recordIntegrity('h1', true)
    tracker.recordIntegrity('broken', true)
    expect(tracker.score('broken')).toBeLessThan(tracker.score('h1'))
  })
})
