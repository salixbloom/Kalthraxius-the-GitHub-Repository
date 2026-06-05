import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlatformDescriptor } from '../types.js'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, request: vi.fn() }
})

import { request } from 'undici'
import { extractWorkableJobs } from '../workable-fetcher.js'

const mockRequest = vi.mocked(request)

const DESCRIPTOR: PlatformDescriptor = {
  id: 'workable',
  name: 'Workable Global',
  baseUrl: 'https://jobs.workable.com/search/Alpha%20Centauri',
  fetcherMode: 'workable-api',
  rateLimit: { requestsPerMinute: 20 },
  pagination: { enabled: true, type: 'cursor', pageParam: 'pageToken', pageSize: 20, maxPages: 3 },
}

function makeJob(overrides: Partial<{
  id: string; title: string; company: string; city: string
  description: string; created: string; url: string
}> = {}) {
  const o = {
    id: 'job-1', title: 'Engineer', company: 'Acme', city: 'London',
    description: '<p>Build things.</p>', created: '2026-06-01T00:00:00Z',
    url: 'https://jobs.workable.com/view/abc/engineer', ...overrides,
  }
  return {
    id: o.id, title: o.title, description: o.description,
    created: o.created, url: o.url,
    company: { title: o.company },
    locations: [`${o.city}, England, United Kingdom`],
    location: { city: o.city, subregion: 'England', countryName: 'United Kingdom' },
  }
}

function makeListingHtml(jobs: ReturnType<typeof makeJob>[], nextPageToken: string | null = 'token-2'): string {
  const data = { totalSize: 100, nextPageToken, jobs }
  return `<html><body><script>
window.jobBoard = { supportedLanguages: [], initialState: { "api/v1/jobs": { "status": 200, "data": ${JSON.stringify(data)} } } };
</script></body></html>`
}

function makeApiResponse(jobs: ReturnType<typeof makeJob>[], nextPageToken: string | null = null) {
  return { totalSize: 100, nextPageToken, jobs }
}

function mockApiPage(response: object) {
  mockRequest.mockResolvedValueOnce({
    statusCode: 200,
    body: { json: async () => response },
    headers: {},
  } as ReturnType<typeof request> extends Promise<infer T> ? T : never)
}

beforeEach(() => vi.clearAllMocks())

describe('extractWorkableJobs — page 1 from window.jobBoard', () => {
  it('extracts jobs from listing HTML without any API calls', async () => {
    const html = makeListingHtml([makeJob(), makeJob({ id: 'job-2', title: 'Designer' })])
    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 1 } }
    const result = await extractWorkableJobs(html, desc)
    expect(result.jobs).toHaveLength(2)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('maps job fields correctly', async () => {
    const html = makeListingHtml([makeJob({
      title: 'Senior Engineer', company: 'Globex', city: 'Berlin',
      description: '<p>Great job.</p>', created: '2026-05-01T00:00:00Z',
    })], null)
    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 1 } }
    const result = await extractWorkableJobs(html, desc)
    const job = result.jobs[0]!
    expect(job.title).toBe('Senior Engineer')
    expect(job.company).toBe('Globex')
    expect(job.location).toBe('Berlin, England, United Kingdom')
    expect(job.description).toBe('Great job.')
    expect(job.postedAt).toBe('2026-05-01T00:00:00Z')
    expect(job.salary).toBeNull()
    expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('stamps a verifiable content hash', async () => {
    const html = makeListingHtml([makeJob()], null)
    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 1 } }
    const { jobs } = await extractWorkableJobs(html, desc)
    const { contentHash } = await import('../job-hash.js')
    for (const job of jobs) {
      expect(job.contentHash).toBe(contentHash({ ...job, contentHash: '' }))
    }
  })

  it('returns empty when window.jobBoard is absent', async () => {
    const result = await extractWorkableJobs('<html><body>nothing</body></html>', DESCRIPTOR)
    expect(result.jobs).toHaveLength(0)
    expect(result.stats.matched).toBe(0)
  })

  it('skips jobs missing title or url', async () => {
    const noTitle = { ...makeJob(), title: '' }
    const noUrl = { ...makeJob({ id: 'job-2' }), url: '' }
    const html = makeListingHtml([noTitle as ReturnType<typeof makeJob>, noUrl as ReturnType<typeof makeJob>], null)
    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 1 } }
    const result = await extractWorkableJobs(html, desc)
    expect(result.jobs).toHaveLength(0)
  })
})

describe('extractWorkableJobs — API pagination', () => {
  it('fetches page 2 using nextPageToken from page 1', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    mockApiPage(makeApiResponse([makeJob({ id: 'job-2', title: 'Designer' })], null))

    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 2 } }
    const result = await extractWorkableJobs(html, desc)
    expect(result.jobs).toHaveLength(2)
    expect(mockRequest).toHaveBeenCalledTimes(1)
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining('pageToken=tok-2'),
      expect.anything(),
    )
  })

  it('chains multiple pages up to maxPages', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    mockApiPage(makeApiResponse([makeJob({ id: 'j2' })], 'tok-3'))
    mockApiPage(makeApiResponse([makeJob({ id: 'j3' })], 'tok-4'))

    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 3 } }
    const result = await extractWorkableJobs(html, desc)
    expect(result.jobs).toHaveLength(3)
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('stops when nextPageToken is null', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    mockApiPage(makeApiResponse([makeJob({ id: 'j2' })], null))

    const result = await extractWorkableJobs(html, DESCRIPTOR)
    expect(result.jobs).toHaveLength(2)
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })

  it('stops when API returns empty jobs array', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    mockApiPage(makeApiResponse([], 'tok-3'))

    const result = await extractWorkableJobs(html, DESCRIPTOR)
    expect(result.jobs).toHaveLength(1)
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })

  it('stops and returns partial results when API fetch fails', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    mockRequest.mockRejectedValueOnce(new Error('network error'))

    const result = await extractWorkableJobs(html, DESCRIPTOR)
    expect(result.jobs).toHaveLength(1)
  })

  it('respects maxPages=1 — no API calls even with a token', async () => {
    const html = makeListingHtml([makeJob()], 'tok-2')
    const desc = { ...DESCRIPTOR, pagination: { ...DESCRIPTOR.pagination, maxPages: 1 } }
    const result = await extractWorkableJobs(html, desc)
    expect(result.jobs).toHaveLength(1)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
