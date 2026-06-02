import { describe, it, expect } from 'vitest'
import { extractSkills } from '../enrichment/skills.js'

function ids(skills: { id: string }[]): string[] {
  return skills.map(s => s.id).sort()
}

describe('extractSkills — exact matches', () => {
  it('finds single-word skills', () => {
    const r = extractSkills('We use Python and Rust on the backend.')
    expect(ids(r)).toContain('python')
    expect(ids(r)).toContain('rust')
  })

  it('matches aliases', () => {
    const r = extractSkills('Strong JS and k8s experience required.')
    expect(ids(r)).toContain('javascript')
    expect(ids(r)).toContain('kubernetes')
  })

  it('matches multi-word skills', () => {
    const r = extractSkills('Experience with Machine Learning and Ruby on Rails.')
    expect(ids(r)).toContain('machine-learning')
    expect(ids(r)).toContain('rails')
  })

  it('matches dotted/symbol surfaces like Node.js and C++', () => {
    const r = extractSkills('Backend in Node.js, some C++ for performance.')
    expect(ids(r)).toContain('nodejs')
    expect(ids(r)).toContain('cpp')
  })

  it('exact matches carry confidence 1.0', () => {
    const r = extractSkills('We love TypeScript.')
    const ts = r.find(s => s.id === 'typescript')
    expect(ts?.confidence).toBe(1.0)
  })
})

describe('extractSkills — fuzzy matches', () => {
  it('catches a single-typo "kubernets" → kubernetes', () => {
    const r = extractSkills('Deploy on kubernets clusters.')
    const k = r.find(s => s.id === 'kubernetes')
    expect(k).toBeDefined()
    expect(k!.confidence).toBeLessThan(1.0)
    expect(k!.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('catches "postgres" via alias exactly (not fuzzy)', () => {
    const r = extractSkills('We run postgres in production.')
    const p = r.find(s => s.id === 'postgresql')
    expect(p?.confidence).toBe(1.0)
  })

  it('does not fuzzy-match very short tokens', () => {
    // "ge" is 2 chars; must not fuzzy-snap to "go" or any skill.
    const r = extractSkills('ge ml ab')
    expect(r.find(s => s.id === 'go')).toBeUndefined()
  })
})

describe('extractSkills — recall on a bullet list', () => {
  it('recovers >80% of an explicit skills section', () => {
    const description = `
      Required skills:
      - Python
      - Django
      - PostgreSQL
      - Redis
      - Docker
      - Kubernetes
      - AWS
      - GraphQL
      - React
      - TypeScript
    `
    const expected = [
      'python', 'django', 'postgresql', 'redis', 'docker',
      'kubernetes', 'aws', 'graphql', 'react', 'typescript',
    ]
    const got = new Set(ids(extractSkills(description)))
    const recovered = expected.filter(id => got.has(id))
    expect(recovered.length / expected.length).toBeGreaterThanOrEqual(0.8)
  })
})

describe('extractSkills — null/empty', () => {
  it('returns [] for text with no known skills', () => {
    expect(extractSkills('We are a friendly team in a sunny office.')).toEqual([])
  })

  it('returns [] for empty input', () => {
    expect(extractSkills(null, undefined, '')).toEqual([])
  })
})
