import { describe, it, expect } from 'vitest'
import { sha256 } from '../hasher.js'

describe('sha256', () => {
  it('produces a 64-char hex string', () => {
    expect(sha256('hello')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic — same input, same hash', () => {
    const content = 'Senior Engineer at Acme Corp'
    expect(sha256(content)).toBe(sha256(content))
  })

  it('different content produces different hashes', () => {
    expect(sha256('job A')).not.toBe(sha256('job B'))
  })
})
