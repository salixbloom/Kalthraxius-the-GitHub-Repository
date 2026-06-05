import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlatformDescriptor } from '../types.js'

// We test the internal helpers by importing the module and exercising
// extractJsonLdJobs with a mocked fetchText (undici request).
// The mock intercepts the detail-page fetches so no network is needed.

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return {
    ...actual,
    request: vi.fn(),
  }
})

import { request } from 'undici'
import { extractJsonLdJobs } from '../json-ld-fetcher.js'

const mockRequest = vi.mocked(request)

function makeDetailHtml(overrides: {
  title?: string
  company?: string
  city?: string
  description?: string
  salary?: string
  datePosted?: string
} = {}): string {
  const o = {
    title: 'Software Engineer',
    company: 'Acme Corp',
    city: 'San Francisco',
    description: '<p>Build great things.</p>',
    salary: '150000',
    datePosted: '2026-06-01',
    ...overrides,
  }
  return `<html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      "title": "${o.title}",
      "description": "${o.description}",
      "datePosted": "${o.datePosted}",
      "hiringOrganization": { "@type": "Organization", "name": "${o.company}" },
      "jobLocation": {
        "@type": "Place",
        "address": { "@type": "PostalAddress", "addressLocality": "${o.city}" }
      },
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": "USD",
        "value": { "@type": "QuantitativeValue", "value": "${o.salary}", "unitText": "YEAR" }
      }
    }
    </script>
  </head><body><h1>${o.title}</h1></body></html>`
}

const ITEM_LIST_LISTING = `<html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "ItemList",
    "numberOfItems": 2,
    "itemListElement": [
      { "@type": "ListItem", "position": 0, "url": "https://jobs.workable.com/view/abc/engineer" },
      { "@type": "ListItem", "position": 1, "url": "https://jobs.workable.com/view/def/designer" }
    ]
  }
  </script>
</head><body></body></html>`

const WINDOW_JOB_BOARD_LISTING = `<html><head></head><body>
<script>
window.jobBoard = {
  "supportedLanguages": ["en"],
  "initialState": {
    "api/v1/jobs": {
      "status": 200,
      "data": {
        "totalSize": 2,
        "nextPageToken": "token123",
        "jobs": [
          { "id": "1", "title": "Porter", "url": "https://jobs.workable.com/view/abc/porter", "company": { "title": "PeakMade" } },
          { "id": "2", "title": "Manager", "url": "https://jobs.workable.com/view/def/manager", "company": { "title": "Acme" } }
        ]
      }
    }
  }
};
</script>
</body></html>`

const BASE_DESCRIPTOR: PlatformDescriptor = {
  id: 'workable',
  name: 'Workable',
  baseUrl: 'https://jobs.workable.com/search/Alpha%20Centauri',
  fetcherMode: 'json-ld-list',
  rateLimit: { requestsPerMinute: 20 },
  jsonLdMapping: {
    listingSource: 'item-list-json-ld',
    title: 'title',
    company: 'hiringOrganization.name',
    location: 'jobLocation.address.addressLocality',
    description: 'description',
    salary: 'baseSalary.value.value',
    postedAt: 'datePosted',
  },
  pagination: { enabled: false, type: 'page', pageParam: 'page', pageSize: 20, maxPages: 1 },
}

function mockDetailFetch(html: string) {
  mockRequest.mockResolvedValue({
    statusCode: 200,
    body: { text: async () => html },
    headers: {},
  } as ReturnType<typeof request> extends Promise<infer T> ? T : never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('extractJsonLdJobs — item-list-json-ld listing source', () => {
  it('extracts URLs from ItemList and fetches each detail page', async () => {
    mockRequest.mockResolvedValue({
      statusCode: 200,
      body: { text: async () => makeDetailHtml() },
      headers: {},
    } as ReturnType<typeof request> extends Promise<infer T> ? T : never)

    const result = await extractJsonLdJobs(ITEM_LIST_LISTING, BASE_DESCRIPTOR)
    expect(result.stats.matched).toBe(2)
    expect(result.jobs).toHaveLength(2)
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('maps JobPosting fields to RawJob correctly', async () => {
    mockDetailFetch(makeDetailHtml({
      title: 'Senior Engineer',
      company: 'Globex',
      city: 'Springfield',
      description: '<p>Build reactors.</p>',
      salary: '200000',
      datePosted: '2026-05-15',
    }))

    const result = await extractJsonLdJobs(ITEM_LIST_LISTING, {
      ...BASE_DESCRIPTOR,
      jsonLdMapping: { ...BASE_DESCRIPTOR.jsonLdMapping!, listingSource: 'item-list-json-ld' },
    })
    const job = result.jobs[0]!
    expect(job.title).toBe('Senior Engineer')
    expect(job.company).toBe('Globex')
    expect(job.location).toBe('Springfield')
    expect(job.description).toBe('Build reactors.')  // HTML stripped
    expect(job.salary).toBe('200000')
    expect(job.postedAt).toBe('2026-05-15')
    expect(job.platformId).toBe('workable')
    expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('stamps a verifiable content hash', async () => {
    mockDetailFetch(makeDetailHtml())
    const { jobs } = await extractJsonLdJobs(ITEM_LIST_LISTING, BASE_DESCRIPTOR)
    const { contentHash } = await import('../job-hash.js')
    for (const job of jobs) {
      const expected = contentHash({ ...job, contentHash: '' })
      expect(job.contentHash).toBe(expected)
    }
  })

  it('skips a detail page that returns no JobPosting JSON-LD', async () => {
    mockRequest
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { text: async () => '<html><body>No JSON-LD here</body></html>' },
        headers: {},
      } as ReturnType<typeof request> extends Promise<infer T> ? T : never)
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { text: async () => makeDetailHtml({ title: 'Designer' }) },
        headers: {},
      } as ReturnType<typeof request> extends Promise<infer T> ? T : never)

    const result = await extractJsonLdJobs(ITEM_LIST_LISTING, BASE_DESCRIPTOR)
    expect(result.stats.matched).toBe(2) // still 2 URLs found
    expect(result.jobs).toHaveLength(1)  // only 1 parsed
    expect(result.jobs[0]!.title).toBe('Designer')
  })

  it('skips a detail page whose fetch throws', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { text: async () => makeDetailHtml({ title: 'Analyst' }) },
        headers: {},
      } as ReturnType<typeof request> extends Promise<infer T> ? T : never)

    const result = await extractJsonLdJobs(ITEM_LIST_LISTING, BASE_DESCRIPTOR)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]!.title).toBe('Analyst')
  })

  it('returns empty when listing has no ItemList JSON-LD', async () => {
    const result = await extractJsonLdJobs('<html><body>nothing</body></html>', BASE_DESCRIPTOR)
    expect(result.stats.matched).toBe(0)
    expect(result.jobs).toHaveLength(0)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('respects salary: null in mapping (omits salary)', async () => {
    mockDetailFetch(makeDetailHtml({ salary: '100000' }))
    const desc: PlatformDescriptor = {
      ...BASE_DESCRIPTOR,
      jsonLdMapping: { ...BASE_DESCRIPTOR.jsonLdMapping!, salary: null },
    }
    const { jobs } = await extractJsonLdJobs(ITEM_LIST_LISTING, desc)
    expect(jobs[0]!.salary).toBeNull()
  })
})

describe('extractJsonLdJobs — window-job-board listing source', () => {
  it('extracts URLs from window.jobBoard initialState', async () => {
    mockDetailFetch(makeDetailHtml())
    const desc: PlatformDescriptor = {
      ...BASE_DESCRIPTOR,
      jsonLdMapping: { ...BASE_DESCRIPTOR.jsonLdMapping!, listingSource: 'window-job-board' },
    }
    const result = await extractJsonLdJobs(WINDOW_JOB_BOARD_LISTING, desc)
    expect(result.stats.matched).toBe(2)
    expect(mockRequest).toHaveBeenCalledTimes(2)
    expect(mockRequest).toHaveBeenCalledWith(
      'https://jobs.workable.com/view/abc/porter',
      expect.anything(),
    )
  })

  it('returns empty when window.jobBoard is absent', async () => {
    const desc: PlatformDescriptor = {
      ...BASE_DESCRIPTOR,
      jsonLdMapping: { ...BASE_DESCRIPTOR.jsonLdMapping!, listingSource: 'window-job-board' },
    }
    const result = await extractJsonLdJobs('<html><body>no script</body></html>', desc)
    expect(result.stats.matched).toBe(0)
    expect(result.jobs).toHaveLength(0)
  })
})
