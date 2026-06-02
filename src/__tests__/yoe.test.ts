import { describe, it, expect } from 'vitest'
import { extractYoe } from '../enrichment/yoe.js'

describe('extractYoe — common phrasings', () => {
  it('"5+ years of experience" → 5', () => {
    expect(extractYoe('5+ years of experience').value).toBe(5)
  })

  it('"3-5 years experience" → 3 (floor)', () => {
    expect(extractYoe('We want 3-5 years experience.').value).toBe(3)
  })

  it('"at least 4 years" → 4', () => {
    expect(extractYoe('Candidates need at least 4 years in the field.').value).toBe(4)
  })

  it('"minimum of 7 years" → 7', () => {
    expect(extractYoe('Minimum of 7 years required.').value).toBe(7)
  })

  it('spelled-out "two years of experience" → 2', () => {
    expect(extractYoe('At minimum two years of experience.').value).toBe(2)
  })

  it('"experience: 5+ years" reversed order → 5', () => {
    expect(extractYoe('Required experience: 5+ years in backend.').value).toBe(5)
  })

  it('"5 yrs+" abbreviated → 5', () => {
    expect(extractYoe('Looking for 5 yrs+ in the role.').value).toBe(5)
  })
})

describe('extractYoe — confidence', () => {
  it('an experience-anchored match is high confidence', () => {
    expect(extractYoe('7+ years of experience').confidence).toBeGreaterThan(0.8)
  })

  it('a bare "5 years" with no anchor is lower confidence', () => {
    const r = extractYoe('The contract is 5 years.')
    // Either null or a low-confidence guess — must not be high confidence.
    expect(r.confidence).toBeLessThan(0.8)
  })
})

describe('extractYoe — null policy', () => {
  it('returns null when no number is present', () => {
    expect(extractYoe('Experience required.').value).toBeNull()
  })

  it('returns null for unrelated text', () => {
    expect(extractYoe('We build distributed systems in Rust.').value).toBeNull()
  })

  it('rejects an implausible value (>50)', () => {
    expect(extractYoe('99 years experience').value).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(extractYoe(null, undefined).value).toBeNull()
  })
})
