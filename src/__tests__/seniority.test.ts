import { describe, it, expect } from 'vitest'
import { extractSeniority } from '../enrichment/seniority.js'

describe('extractSeniority — title signal (primary)', () => {
  const cases: Array<[string, string]> = [
    ['Senior Software Engineer', 'senior'],
    ['Sr. Backend Developer', 'senior'],
    ['Junior Data Analyst', 'junior'],
    ['Jr Frontend Developer', 'junior'],
    ['Staff Engineer', 'staff'],
    ['Principal Engineer', 'principal'],
    ['Engineering Manager', 'manager'],
    ['Tech Lead', 'lead'],
    ['Director of Engineering', 'director'],
    ['VP of Product', 'executive'],
    ['Head of Data', 'executive'],
    ['Software Engineering Intern', 'intern'],
    ['Graduate Software Engineer', 'junior'],
  ]

  for (const [title, expected] of cases) {
    it(`"${title}" → ${expected}`, () => {
      const r = extractSeniority(title)
      expect(r.value).toBe(expected)
      expect(r.confidence).toBeGreaterThan(0.9)
    })
  }
})

describe('extractSeniority — precedence', () => {
  it('"Senior Staff Engineer" resolves to staff (more specific wins)', () => {
    expect(extractSeniority('Senior Staff Engineer').value).toBe('staff')
  })

  it('"Engineering Manager" resolves to manager, not mid', () => {
    expect(extractSeniority('Engineering Manager').value).toBe('manager')
  })
})

describe('extractSeniority — description signal (secondary)', () => {
  it('uses an explicit description signal when the title carries no level modifier', () => {
    // "Software Engineer" matches no seniority *modifier* in the title, so the
    // secondary description signal ("senior") is consulted before the soft
    // mid default. An explicit signal beats a guessed default.
    const r = extractSeniority('Software Engineer', 'We need a seasoned, senior engineer.')
    expect(r.value).toBe('senior')
    expect(r.confidence).toBeCloseTo(0.6, 1)
  })

  it('soft mid default only when both title and description are silent', () => {
    const r = extractSeniority('Software Engineer', 'Join our team building APIs.')
    expect(r.value).toBe('mid')
    expect(r.confidence).toBeLessThan(0.5)
  })

  it('uses description when title is entirely absent', () => {
    const r = extractSeniority(null, 'This is an entry-level role, no experience required.')
    expect(r.value).toBe('junior')
    expect(r.confidence).toBeCloseTo(0.6, 1)
  })
})

describe('extractSeniority — soft default and null', () => {
  it('plain "Software Engineer" → mid at low confidence', () => {
    const r = extractSeniority('Software Engineer')
    expect(r.value).toBe('mid')
    expect(r.confidence).toBeLessThan(0.5)
  })

  it('non-job title with no signal → null', () => {
    const r = extractSeniority('Cleaner', null)
    expect(r.value).toBeNull()
  })

  it('empty input → null', () => {
    expect(extractSeniority(null, null).value).toBeNull()
  })
})
