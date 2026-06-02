import { describe, it, expect } from 'vitest'
import { extractSalary } from '../enrichment/salary.js'

describe('extractSalary — ranges', () => {
  it('parses "$120,000 - $150,000"', () => {
    const r = extractSalary('$120,000 - $150,000')
    expect(r.value).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: 'year' })
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  it('parses k-notation "$120k–$150k" with en dash', () => {
    const r = extractSalary('$120k–$150k')
    expect(r.value).toMatchObject({ min: 120000, max: 150000, currency: 'USD' })
  })

  it('inherits the upper suffix for a bare lower bound "120 - 150k"', () => {
    const r = extractSalary('120 - 150k')
    expect(r.value).toMatchObject({ min: 120000, max: 150000 })
  })

  it('parses "£90k to £110k"', () => {
    const r = extractSalary('£90k to £110k')
    expect(r.value).toMatchObject({ min: 90000, max: 110000, currency: 'GBP' })
  })

  it('parses euro "€80.000–€100.000" style is out of scope but € symbol works', () => {
    const r = extractSalary('€80,000 - €100,000 per year')
    expect(r.value).toMatchObject({ min: 80000, max: 100000, currency: 'EUR', period: 'year' })
  })

  it('orders min/max regardless of input order', () => {
    const r = extractSalary('$150k - $120k')
    expect(r.value).toMatchObject({ min: 120000, max: 150000 })
  })
})

describe('extractSalary — period detection', () => {
  it('detects hourly "$50/hr"', () => {
    const r = extractSalary('$50/hr')
    expect(r.value).toMatchObject({ min: 50, max: 50, period: 'hour' })
  })

  it('detects "$45 - $55 per hour"', () => {
    const r = extractSalary('$45 - $55 per hour')
    expect(r.value).toMatchObject({ min: 45, max: 55, period: 'hour' })
  })

  it('infers hourly from a small bare number', () => {
    const r = extractSalary('Pay: $55')
    expect(r.value?.period).toBe('hour')
  })

  it('infers annual for a large number', () => {
    const r = extractSalary('Salary: $130,000')
    expect(r.value?.period).toBe('year')
  })
})

describe('extractSalary — currency codes', () => {
  it('detects USD code without a symbol', () => {
    const r = extractSalary('100,000 - 120,000 USD annually')
    expect(r.value).toMatchObject({ currency: 'USD', period: 'year' })
  })
})

describe('extractSalary — null policy', () => {
  it('returns null for text with no salary', () => {
    const r = extractSalary('We are hiring a backend engineer in Berlin.')
    expect(r.value).toBeNull()
    expect(r.confidence).toBe(0)
  })

  it('does not treat a stray year as a salary', () => {
    const r = extractSalary('Founded in 2019, growing fast.')
    expect(r.value).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(extractSalary(null, undefined, '').value).toBeNull()
  })
})

describe('extractSalary — multi-source', () => {
  it('falls back to description when the salary field is null', () => {
    const r = extractSalary(null, 'Compensation is $140k - $170k DOE.')
    expect(r.value).toMatchObject({ min: 140000, max: 170000 })
  })
})
