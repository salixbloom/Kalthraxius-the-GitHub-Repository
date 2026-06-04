import { describe, it, expect } from 'vitest'
import { pageUrl, maxPagesFor, paginationEnabled } from '../pagination.js'
import type { PlatformDescriptor } from '../types.js'

function descriptor(p: Partial<PlatformDescriptor['pagination']>): PlatformDescriptor {
  return {
    id: 'test',
    name: 'Test',
    baseUrl: 'https://jobs.example.com/list',
    fetcherMode: 'http',
    rateLimit: { requestsPerMinute: 60 },
    pagination: { type: 'page', pageParam: 'page', pageSize: 25, maxPages: 10, ...p },
    selectors: {
      jobList: '.j', jobLink: 'a', title: '.t', company: '.c',
      location: '.l', description: '.d',
    },
  }
}

describe('pageUrl — page type', () => {
  const pag = descriptor({ type: 'page', pageParam: 'page', pageSize: 25 }).pagination

  it('page 0 is the base URL, untouched', () => {
    expect(pageUrl('https://jobs.example.com/list', pag, 0)).toBe('https://jobs.example.com/list')
  })

  it('page index → 1-based page number', () => {
    expect(pageUrl('https://jobs.example.com/list', pag, 1)).toBe('https://jobs.example.com/list?page=2')
    expect(pageUrl('https://jobs.example.com/list', pag, 4)).toBe('https://jobs.example.com/list?page=5')
  })

  it('preserves existing query params', () => {
    expect(pageUrl('https://jobs.example.com/list?team=eng', pag, 1)).toBe(
      'https://jobs.example.com/list?team=eng&page=2',
    )
  })
})

describe('pageUrl — offset type', () => {
  const pag = descriptor({ type: 'offset', pageParam: 'page', pageSize: 25 }).pagination

  it('page index → row offset stepped by pageSize', () => {
    expect(pageUrl('https://x/jobs', pag, 1)).toBe('https://x/jobs?page=25')
    expect(pageUrl('https://x/jobs', pag, 2)).toBe('https://x/jobs?page=50')
    expect(pageUrl('https://x/jobs', pag, 4)).toBe('https://x/jobs?page=100')
  })
})

describe('pageUrl — cursor type', () => {
  const pag = descriptor({ type: 'cursor' }).pagination

  it('only ever returns the base URL (later pages come from extracted links)', () => {
    expect(pageUrl('https://x/jobs', pag, 0)).toBe('https://x/jobs')
    expect(pageUrl('https://x/jobs', pag, 3)).toBe('https://x/jobs')
  })
})

describe('paginationEnabled / maxPagesFor', () => {
  it('disabled when enabled is omitted', () => {
    expect(paginationEnabled(descriptor({}))).toBe(false)
    expect(maxPagesFor(descriptor({ maxPages: 10 }))).toBe(1) // off → just the base page
  })

  it('disabled when enabled is false', () => {
    expect(paginationEnabled(descriptor({ enabled: false, maxPages: 10 }))).toBe(false)
    expect(maxPagesFor(descriptor({ enabled: false, maxPages: 10 }))).toBe(1)
  })

  it('enabled honors maxPages (min 1)', () => {
    expect(paginationEnabled(descriptor({ enabled: true, maxPages: 10 }))).toBe(true)
    expect(maxPagesFor(descriptor({ enabled: true, maxPages: 10 }))).toBe(10)
    expect(maxPagesFor(descriptor({ enabled: true, maxPages: 0 }))).toBe(1)
  })
})
