import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'playwright'
import { extractJobs, extractNextLink } from '../extractor.js'
import { validateDescriptor } from '../descriptor-validator.js'
import { verifyIntegrity } from '../job-hash.js'
import { browserAvailable } from './helpers/browser.js'
import type { Browser } from 'playwright'
import type { PlatformDescriptor } from '../types.js'

// Browser-driven tests skip gracefully where Chromium can't launch (e.g. WSL
// without Playwright's system libs). Install deps to exercise them.
const HAS_BROWSER = await browserAvailable()
const bIt = HAS_BROWSER ? it : it.skip

const DESCRIPTOR: PlatformDescriptor = {
  id: 'greenhouse-test',
  name: 'Greenhouse Test',
  baseUrl: 'https://boards.greenhouse.io/acme/',
  fetcherMode: 'http',
  rateLimit: { requestsPerMinute: 30 },
  pagination: { type: 'page', pageParam: 'page', pageSize: 25, maxPages: 5 },
  selectors: {
    jobList: '.job',
    jobLink: 'a.job-link',
    title: '.job-title',
    company: '.job-company',
    location: '.job-location',
    description: '.job-desc',
    salary: '.job-salary',
    postedAt: '.job-date',
  },
}

const GOOD_HTML = `
  <html><body>
    <div class="listings">
      <div class="job">
        <a class="job-link" href="/acme/jobs/1">link</a>
        <span class="job-title">Senior Backend Engineer</span>
        <span class="job-company">Acme</span>
        <span class="job-location">Remote</span>
        <div class="job-desc">Python, Django, PostgreSQL. 5+ years.</div>
        <span class="job-salary">$150k - $180k</span>
        <span class="job-date">2026-05-01</span>
      </div>
      <div class="job">
        <a class="job-link" href="/acme/jobs/2">link</a>
        <span class="job-title">Frontend Developer</span>
        <span class="job-company">Acme</span>
        <span class="job-location">Seattle, WA</span>
        <div class="job-desc">React, TypeScript.</div>
        <span class="job-salary">$120k - $150k</span>
        <span class="job-date">2026-05-02</span>
      </div>
    </div>
  </body></html>
`

let browser: Browser | undefined

beforeAll(async () => {
  if (HAS_BROWSER) browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser?.close()
})

describe('extractJobs', () => {
  bIt('extracts structured jobs from HTML via selectors', async () => {
    const { jobs, stats } = await extractJobs(GOOD_HTML, DESCRIPTOR, { browser: browser! })
    expect(stats.matched).toBe(2)
    expect(jobs).toHaveLength(2)

    const senior = jobs.find(j => j.title.includes('Senior'))!
    expect(senior.company).toBe('Acme')
    expect(senior.salary).toBe('$150k - $180k')
    expect(senior.platformId).toBe('greenhouse-test')
    // jobLink resolved to an absolute URL against baseUrl.
    expect(senior.url).toBe('https://boards.greenhouse.io/acme/jobs/1')
  })

  bIt('stamps a verifiable content hash on each job (closes the Phase 7 gap)', async () => {
    const { jobs } = await extractJobs(GOOD_HTML, DESCRIPTOR, { browser: browser! })
    for (const job of jobs) {
      expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(verifyIntegrity(job).ok).toBe(true)
    }
  })

  bIt('skips rows missing a URL or title', async () => {
    const html = `
      <div class="job"><span class="job-title">Has title but no link</span></div>
      <div class="job"><a class="job-link" href="/x">link</a></div>
    `
    const { jobs, stats } = await extractJobs(html, DESCRIPTOR, { browser: browser! })
    expect(stats.matched).toBe(2)
    expect(jobs).toHaveLength(0) // neither row is complete
  })
})

describe('validateDescriptor (Phase 8 gate)', () => {
  bIt('reports ok for a well-formed descriptor + page', async () => {
    const report = await validateDescriptor(GOOD_HTML, DESCRIPTOR, { browser: browser! })
    expect(report.ok).toBe(true)
    expect(report.jobsExtracted).toBe(2)
    expect(report.fields.find(f => f.field === 'title')?.status).toBe('ok')
  })

  bIt('reports FAILURE on a broken required selector', async () => {
    const broken: PlatformDescriptor = {
      ...DESCRIPTOR,
      selectors: { ...DESCRIPTOR.selectors, title: '.does-not-exist' },
    }
    const report = await validateDescriptor(GOOD_HTML, broken, { browser: browser! })
    expect(report.ok).toBe(false)
    expect(report.fields.find(f => f.field === 'title')?.status).toBe('broken')
  })

  bIt('reports BROKEN jobList when nothing matches', async () => {
    const broken: PlatformDescriptor = {
      ...DESCRIPTOR,
      selectors: { ...DESCRIPTOR.selectors, jobList: '.no-such-list' },
    }
    const report = await validateDescriptor(GOOD_HTML, broken, { browser: browser! })
    expect(report.ok).toBe(false)
    expect(report.jobListMatches).toBe(0)
  })

  bIt('warns (not fails) on a missing optional selector', async () => {
    // salary present in markup but selector points nowhere → optional warn.
    const desc: PlatformDescriptor = {
      ...DESCRIPTOR,
      selectors: { ...DESCRIPTOR.selectors, salary: '.no-salary-here' },
    }
    const report = await validateDescriptor(GOOD_HTML, desc, { browser: browser! })
    expect(report.ok).toBe(true)
    expect(report.fields.find(f => f.field === 'salary')?.status).toBe('warn')
  })
})

describe('extractNextLink (cursor pagination)', () => {
  const cursorDesc: PlatformDescriptor = {
    ...DESCRIPTOR,
    pagination: { ...DESCRIPTOR.pagination, type: 'cursor' },
    selectors: { ...DESCRIPTOR.selectors, nextLink: 'a.next' },
  }
  const PAGE = `<html><body>
    <a class="prev" href="/acme/page/1">Prev</a>
    <a class="next" href="/acme/page/3">Next</a>
  </body></html>`

  bIt('extracts the next-page link, resolved to an absolute URL', async () => {
    const next = await extractNextLink(PAGE, cursorDesc, 'https://boards.greenhouse.io/acme/page/2', { browser: browser! })
    expect(next).toBe('https://boards.greenhouse.io/acme/page/3')
  })

  bIt('returns null when there is no next link (end of board)', async () => {
    const last = `<html><body><a class="prev" href="/acme/page/1">Prev</a></body></html>`
    const next = await extractNextLink(last, cursorDesc, 'https://boards.greenhouse.io/acme/page/2', { browser: browser! })
    expect(next).toBeNull()
  })

  bIt('returns null when no nextLink selector is configured', async () => {
    const noSelector: PlatformDescriptor = { ...DESCRIPTOR }
    const next = await extractNextLink(PAGE, noSelector, 'https://boards.greenhouse.io/acme/', { browser: browser! })
    expect(next).toBeNull()
  })
})
