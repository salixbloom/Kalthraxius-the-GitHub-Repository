import { describe, it, expect } from 'vitest'
import { runQuery } from '../query/engine.js'
import type { IndexedJob } from '../aggregator/store.js'
import type { Enrichment, RawJob } from '../types.js'
import type { QueryProfile } from '../query/types.js'

const DAY_MS = 24 * 60 * 60 * 1000

function indexed(opts: {
  hash: string
  yoe?: number | null
  salaryMax?: number | null
  skills?: string[]
  location?: string
  ageDays?: number
}): IndexedJob {
  const job: RawJob = {
    contentHash: opts.hash,
    platformId: 'greenhouse',
    url: `https://example.com/${opts.hash}`,
    title: 'Engineer',
    company: 'Acme',
    location: opts.location ?? 'Remote',
    description: '',
    salary: null,
    postedAt: null,
    scrapedAt: Date.now() - (opts.ageDays ?? 0) * DAY_MS,
  }
  const enrichment: Enrichment = {
    contentHash: opts.hash,
    salary:
      opts.salaryMax === undefined
        ? { value: null, confidence: 0 }
        : opts.salaryMax === null
          ? { value: null, confidence: 0 }
          : { value: { min: opts.salaryMax - 20000, max: opts.salaryMax, currency: 'USD', period: 'year' }, confidence: 0.9 },
    yoe: opts.yoe === undefined || opts.yoe === null ? { value: null, confidence: 0 } : { value: opts.yoe, confidence: 0.9 },
    seniority: { value: null, confidence: 0 },
    skills: (opts.skills ?? []).map(id => ({ id, label: id, confidence: 1 })),
    schemaVersion: 1,
    enrichedAt: Date.now(),
  }
  return { job, enrichment }
}

describe('hard filter — yoeMax', () => {
  it('excludes a job requiring more YOE than the chosen ceiling', () => {
    const jobs = [indexed({ hash: 'low', yoe: 2 }), indexed({ hash: 'high', yoe: 7 })]
    const profile: QueryProfile = { stack: [], yoeMax: 3 }
    const hits = runQuery(jobs, profile)
    expect(hits.map(h => h.contentHash)).toEqual(['low'])
  })

  it('the 7-YOE job IS returned when the user raises the ceiling (user controls)', () => {
    const jobs = [indexed({ hash: 'high', yoe: 7 })]
    expect(runQuery(jobs, { stack: [], yoeMax: 8 }).map(h => h.contentHash)).toEqual(['high'])
  })

  it('no yoeMax = no YOE filtering at all', () => {
    const jobs = [indexed({ hash: 'a', yoe: 2 }), indexed({ hash: 'b', yoe: 12 })]
    expect(runQuery(jobs, { stack: [] }).length).toBe(2)
  })
})

describe('hard filter — salaryFloor', () => {
  it('excludes a job whose salary max is below the floor', () => {
    const jobs = [indexed({ hash: 'rich', salaryMax: 200000 }), indexed({ hash: 'poor', salaryMax: 90000 })]
    expect(runQuery(jobs, { stack: [], salaryFloor: 120000 }).map(h => h.contentHash)).toEqual(['rich'])
  })
})

describe('includeUnknown null policy', () => {
  it('default (true): null YOE passes a yoeMax filter as "assumed"', () => {
    const jobs = [indexed({ hash: 'unknown', yoe: null })]
    const hits = runQuery(jobs, { stack: [], yoeMax: 3 })
    expect(hits.map(h => h.contentHash)).toEqual(['unknown'])
    expect(hits[0]!.qualification).toBe('assumed')
  })

  it('false: null YOE is excluded when a yoeMax filter is active', () => {
    const jobs = [indexed({ hash: 'unknown', yoe: null }), indexed({ hash: 'known', yoe: 2 })]
    const hits = runQuery(jobs, { stack: [], yoeMax: 3, includeUnknown: false })
    expect(hits.map(h => h.contentHash)).toEqual(['known'])
    expect(hits[0]!.qualification).toBe('confirmed')
  })

  it('false: null salary is excluded when salaryFloor is active', () => {
    const jobs = [indexed({ hash: 'nosal', salaryMax: null }), indexed({ hash: 'sal', salaryMax: 150000 })]
    const hits = runQuery(jobs, { stack: [], salaryFloor: 120000, includeUnknown: false })
    expect(hits.map(h => h.contentHash)).toEqual(['sal'])
  })

  it('a null field on an UNfiltered axis never matters', () => {
    // yoe null but no yoeMax filter → passes, confirmed.
    const hits = runQuery([indexed({ hash: 'a', yoe: null })], { stack: [], includeUnknown: false })
    expect(hits[0]?.qualification).toBe('confirmed')
  })
})

describe('location filter', () => {
  it('remote jobs match a specific-city query', () => {
    const jobs = [indexed({ hash: 'rem', location: 'Remote' })]
    expect(runQuery(jobs, { stack: [], location: 'Seattle' }).length).toBe(1)
  })

  it('a city job is excluded for a different city', () => {
    const jobs = [indexed({ hash: 'nyc', location: 'New York, NY' })]
    expect(runQuery(jobs, { stack: [], location: 'Seattle' }).length).toBe(0)
  })

  it('matches "Seattle" against "Seattle, WA"', () => {
    const jobs = [indexed({ hash: 'sea', location: 'Seattle, WA' })]
    expect(runQuery(jobs, { stack: [], location: 'Seattle' }).length).toBe(1)
  })
})

describe('scoring — stack overlap', () => {
  it('a higher-overlap job outranks a lower-overlap job', () => {
    const jobs = [
      indexed({ hash: 'two', skills: ['python', 'django'] }),
      indexed({ hash: 'one', skills: ['python'] }),
    ]
    const hits = runQuery(jobs, { stack: ['python', 'django'] })
    expect(hits[0]!.contentHash).toBe('two')
    expect(hits[0]!.matchedSkills.sort()).toEqual(['django', 'python'])
  })

  it('skills never exclude — a zero-overlap job still appears', () => {
    const jobs = [indexed({ hash: 'nomatch', skills: ['cobol'] })]
    expect(runQuery(jobs, { stack: ['python'] }).length).toBe(1)
  })
})

describe('ranking — freshness with 60+ day penalty', () => {
  it('a 2-day posting outranks an identical 90-day posting', () => {
    const jobs = [
      indexed({ hash: 'old', skills: ['python'], ageDays: 90 }),
      indexed({ hash: 'fresh', skills: ['python'], ageDays: 2 }),
    ]
    const hits = runQuery(jobs, { stack: ['python'] })
    expect(hits[0]!.contentHash).toBe('fresh')
  })

  it('stack overlap dominates freshness (strong match beats mere recency)', () => {
    const jobs = [
      indexed({ hash: 'freshweak', skills: [], ageDays: 0 }),
      indexed({ hash: 'oldstrong', skills: ['python', 'aws'], ageDays: 30 }),
    ]
    const hits = runQuery(jobs, { stack: ['python', 'aws'] })
    expect(hits[0]!.contentHash).toBe('oldstrong')
  })
})

describe('5 known profiles against a seeded set', () => {
  const seed: IndexedJob[] = [
    indexed({ hash: 'j-py-jr', yoe: 2, salaryMax: 130000, skills: ['python'], location: 'Remote', ageDays: 1 }),
    indexed({ hash: 'j-py-sr', yoe: 7, salaryMax: 200000, skills: ['python', 'aws'], location: 'Seattle, WA', ageDays: 3 }),
    indexed({ hash: 'j-js', yoe: 4, salaryMax: 160000, skills: ['javascript', 'react'], location: 'Remote', ageDays: 10 }),
    indexed({ hash: 'j-go', yoe: 5, salaryMax: 180000, skills: ['go', 'kubernetes'], location: 'New York, NY', ageDays: 40 }),
    indexed({ hash: 'j-data', yoe: 3, salaryMax: 150000, skills: ['python', 'spark'], location: 'Remote', ageDays: 70 }),
  ]

  it('junior python dev, yoeMax 3, wants ≥120k', () => {
    const hits = runQuery(seed, { stack: ['python'], yoeMax: 3, salaryFloor: 120000 })
    const ids = hits.map(h => h.contentHash)
    expect(ids).toContain('j-py-jr')
    expect(ids).toContain('j-data')
    expect(ids).not.toContain('j-py-sr') // needs 7 yoe
    expect(ids).not.toContain('j-js') // no python overlap but still returned? skills don't exclude
  })

  it('skills do not exclude — JS job appears even for a python profile', () => {
    const hits = runQuery(seed, { stack: ['python'] })
    expect(hits.map(h => h.contentHash)).toContain('j-js')
  })

  it('senior with high floor sees only the senior role', () => {
    const hits = runQuery(seed, { stack: ['python', 'aws'], yoeMax: 8, salaryFloor: 190000 })
    expect(hits.map(h => h.contentHash)).toEqual(['j-py-sr'])
  })

  it('go engineer in NYC', () => {
    const hits = runQuery(seed, { stack: ['go', 'kubernetes'], yoeMax: 5, location: 'New York' })
    expect(hits[0]!.contentHash).toBe('j-go')
    expect(hits[0]!.matchedSkills.sort()).toEqual(['go', 'kubernetes'])
  })

  it('limit caps the result count', () => {
    expect(runQuery(seed, { stack: ['python'], limit: 2 }).length).toBe(2)
  })
})
