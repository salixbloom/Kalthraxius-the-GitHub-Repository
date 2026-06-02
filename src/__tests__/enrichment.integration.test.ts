import { describe, it, expect } from 'vitest'
import { enrichJob } from '../enrichment/enrich.js'
import { SAMPLE_POSTINGS } from './fixtures/sample-postings.js'

/**
 * Phase 4 verification gates, run against the sample-posting fixture
 * (10 postings across greenhouse / lever / linkedin).
 */
describe('Phase 4 quality gates', () => {
  const results = SAMPLE_POSTINGS.map(p => ({ ...p, enrichment: enrichJob(p.job) }))

  it('salary null rate < 10% on postings with a visible salary', () => {
    const visible = results.filter(r => r.expect.hasVisibleSalary)
    const missed = visible.filter(r => r.enrichment.salary.value === null)
    const nullRate = missed.length / visible.length
    if (missed.length) {
      // Surface which ones missed, to make a regression actionable.
      console.error('Missed salaries:', missed.map(m => m.job.title))
    }
    expect(nullRate).toBeLessThan(0.1)
  })

  it('seniority accuracy > 90% on postings with an explicit title signal', () => {
    const withSignal = results.filter(r => r.expect.seniority !== undefined)
    const correct = withSignal.filter(r => r.enrichment.seniority.value === r.expect.seniority)
    if (correct.length !== withSignal.length) {
      const wrong = withSignal
        .filter(r => r.enrichment.seniority.value !== r.expect.seniority)
        .map(r => `${r.job.title}: got ${r.enrichment.seniority.value}, want ${r.expect.seniority}`)
      console.error('Seniority misses:', wrong)
    }
    expect(correct.length / withSignal.length).toBeGreaterThan(0.9)
  })

  it('skills recall > 80% on explicit skills sections', () => {
    const withSkills = results.filter(r => (r.expect.skills?.length ?? 0) > 0)
    let expectedTotal = 0
    let recovered = 0
    for (const r of withSkills) {
      const got = new Set(r.enrichment.skills.map(s => s.id))
      for (const id of r.expect.skills!) {
        expectedTotal++
        if (got.has(id)) recovered++
      }
    }
    expect(recovered / expectedTotal).toBeGreaterThan(0.8)
  })

  it('does not hallucinate salaries on postings without one', () => {
    const noSalary = results.filter(r => !r.expect.hasVisibleSalary)
    for (const r of noSalary) {
      expect(r.enrichment.salary.value).toBeNull()
    }
  })

  it('every enrichment is stamped with the current schema version', () => {
    for (const r of results) {
      expect(r.enrichment.schemaVersion).toBe(1)
      expect(r.enrichment.enrichedAt).toBeGreaterThan(0)
    }
  })
})
