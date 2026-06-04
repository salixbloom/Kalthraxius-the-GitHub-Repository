import { describe, it, expect } from 'vitest'
import { walkPages } from '../bin/scrape-pass.js'
import type { PageResult } from '../bin/scrape-pass.js'
import type { PlatformDescriptor } from '../types.js'

function descriptor(p: Partial<PlatformDescriptor['pagination']>): PlatformDescriptor {
  return {
    id: 'test',
    name: 'Test',
    baseUrl: 'https://x/jobs',
    fetcherMode: 'http',
    rateLimit: { requestsPerMinute: 60 },
    pagination: { type: 'page', pageParam: 'page', pageSize: 25, maxPages: 5, ...p },
    selectors: { jobList: '.j', jobLink: 'a', title: '.t', company: '.c', location: '.l', description: '.d' },
  }
}

const page = (over: Partial<PageResult> = {}): PageResult => ({
  skipped: false, jobCount: 3, published: 3, html: '<html></html>', ...over,
})

/** Records every URL passed to scrapePage, returning queued results in order. */
function recorder(results: PageResult[]) {
  const urls: string[] = []
  let i = 0
  const scrapePage = async (url: string): Promise<PageResult> => {
    urls.push(url)
    return results[i++] ?? page({ jobCount: 0, published: 0 })
  }
  return { urls, scrapePage }
}

const noCursor = async () => null

describe('walkPages — pagination disabled', () => {
  it('fetches only the base URL', async () => {
    const { urls, scrapePage } = recorder([page()])
    const published = await walkPages(descriptor({ enabled: false }), 'https://x/jobs', scrapePage, noCursor)
    expect(urls).toEqual(['https://x/jobs'])
    expect(published).toBe(3)
  })
})

describe('walkPages — page/offset stop conditions', () => {
  it('walks up to maxPages (page type)', async () => {
    const { urls, scrapePage } = recorder([page(), page(), page(), page(), page()])
    await walkPages(descriptor({ enabled: true, type: 'page', maxPages: 3 }), 'https://x/jobs', scrapePage, noCursor)
    // page 0 = base, then ?page=2, ?page=3 — 3 pages, then stop at maxPages.
    expect(urls).toEqual(['https://x/jobs', 'https://x/jobs?page=2', 'https://x/jobs?page=3'])
  })

  it('stops early on an empty page (end of results)', async () => {
    const { urls, scrapePage } = recorder([page(), page({ jobCount: 0, published: 0 })])
    await walkPages(descriptor({ enabled: true, type: 'page', maxPages: 10 }), 'https://x/jobs', scrapePage, noCursor)
    expect(urls).toEqual(['https://x/jobs', 'https://x/jobs?page=2'])
  })

  it('offset steps the param by pageSize', async () => {
    const { urls, scrapePage } = recorder([page(), page(), page()])
    await walkPages(descriptor({ enabled: true, type: 'offset', pageSize: 25, maxPages: 3 }), 'https://x/jobs', scrapePage, noCursor)
    expect(urls).toEqual(['https://x/jobs', 'https://x/jobs?page=25', 'https://x/jobs?page=50'])
  })

  it('keeps walking past a SKIPPED page (a peer owns it), not treating it as empty', async () => {
    const { urls, scrapePage } = recorder([
      page({ skipped: true, jobCount: 0, published: 0, html: null }), // peer owns page 0
      page(), // we still try page 1
      page({ jobCount: 0, published: 0 }), // real end
    ])
    await walkPages(descriptor({ enabled: true, type: 'page', maxPages: 10 }), 'https://x/jobs', scrapePage, noCursor)
    expect(urls).toEqual(['https://x/jobs', 'https://x/jobs?page=2', 'https://x/jobs?page=3'])
  })

  it('sums published across pages', async () => {
    const { scrapePage } = recorder([page({ published: 3 }), page({ published: 2 }), page({ jobCount: 0, published: 0 })])
    const total = await walkPages(descriptor({ enabled: true, type: 'page', maxPages: 10 }), 'https://x/jobs', scrapePage, noCursor)
    expect(total).toBe(5)
  })
})

describe('walkPages — cursor', () => {
  it('follows next links until none is returned', async () => {
    const { urls, scrapePage } = recorder([page(), page(), page()])
    const links = ['https://x/jobs?c=2', 'https://x/jobs?c=3', null]
    let i = 0
    const nextCursor = async () => links[i++] ?? null
    await walkPages(descriptor({ enabled: true, type: 'cursor', maxPages: 10 }), 'https://x/jobs', scrapePage, nextCursor)
    expect(urls).toEqual(['https://x/jobs', 'https://x/jobs?c=2', 'https://x/jobs?c=3'])
  })

  it('stops if the next cursor repeats the current URL (loop guard)', async () => {
    const { urls, scrapePage } = recorder([page(), page()])
    const nextCursor = async (_html: string, currentUrl: string) => currentUrl // points to itself
    await walkPages(descriptor({ enabled: true, type: 'cursor', maxPages: 10 }), 'https://x/jobs', scrapePage, nextCursor)
    expect(urls).toEqual(['https://x/jobs']) // only the first page
  })

  it('respects maxPages even with more next links available', async () => {
    const { urls, scrapePage } = recorder([page(), page(), page(), page()])
    let n = 1
    const nextCursor = async () => `https://x/jobs?c=${++n}`
    await walkPages(descriptor({ enabled: true, type: 'cursor', maxPages: 2 }), 'https://x/jobs', scrapePage, nextCursor)
    expect(urls.length).toBe(2)
  })
})
