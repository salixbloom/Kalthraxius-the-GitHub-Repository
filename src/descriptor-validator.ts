import { extractJobs } from './extractor.js'
import type { Browser } from 'playwright'
import type { PlatformDescriptor } from './types.js'

/**
 * Descriptor validator core (PLAN.md Phase 8: "dry scrape, report extraction
 * results"). Given a descriptor and a page's HTML, runs the extractor and
 * reports per-selector health. The CLI wrapper (cli/validate-descriptor.ts)
 * handles fetching and process exit; this stays pure/testable.
 *
 * Required fields (jobList, jobLink, title) that match zero nodes are FAILURES;
 * optional fields (salary, postedAt) matching zero are warnings.
 */

export interface FieldResult {
  field: string
  matched: number
  required: boolean
  status: 'ok' | 'warn' | 'broken'
}

export interface ValidationReport {
  descriptorId: string
  jobListMatches: number
  jobsExtracted: number
  fields: FieldResult[]
  /** True iff no required selector is broken. CLI maps false → exit 1. */
  ok: boolean
}

const REQUIRED_FIELDS = ['title'] as const
const OPTIONAL_FIELDS = ['company', 'location', 'description', 'salary', 'postedAt'] as const

export async function validateDescriptor(
  html: string,
  descriptor: PlatformDescriptor,
  opts: { browser?: Browser } = {},
): Promise<ValidationReport> {
  const { jobs, stats } = await extractJobs(html, descriptor, { browser: opts.browser })

  const fields: FieldResult[] = []

  // jobList itself: zero matches is a hard failure (nothing to scrape).
  const jobListBroken = stats.matched === 0
  fields.push({
    field: 'jobList',
    matched: stats.matched,
    required: true,
    status: jobListBroken ? 'broken' : 'ok',
  })

  // jobLink: required — without URLs we can't dedup or verify.
  const linkMatches = jobs.filter(j => j.url).length
  fields.push({
    field: 'jobLink',
    matched: linkMatches,
    required: true,
    status: stats.matched > 0 && linkMatches === 0 ? 'broken' : 'ok',
  })

  for (const f of REQUIRED_FIELDS) {
    const matched = stats.fieldCoverage[f] ?? 0
    fields.push({
      field: f,
      matched,
      required: true,
      status: stats.matched > 0 && matched === 0 ? 'broken' : 'ok',
    })
  }

  for (const f of OPTIONAL_FIELDS) {
    // Skip optional fields the descriptor doesn't even define a selector for.
    if (f === 'salary' && !descriptor.selectors.salary) continue
    if (f === 'postedAt' && !descriptor.selectors.postedAt) continue
    const matched = stats.fieldCoverage[f] ?? 0
    fields.push({
      field: f,
      matched,
      required: false,
      status: matched === 0 ? 'warn' : 'ok',
    })
  }

  const ok = !fields.some(f => f.status === 'broken')
  return {
    descriptorId: descriptor.id,
    jobListMatches: stats.matched,
    jobsExtracted: jobs.length,
    fields,
    ok,
  }
}

/** Render a report as human-readable lines (used by the CLI). */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = []
  lines.push(`Descriptor: ${report.descriptorId}`)
  lines.push(`  jobList matched ${report.jobListMatches} node(s); extracted ${report.jobsExtracted} job(s)`)
  for (const f of report.fields) {
    const tag = f.status === 'ok' ? 'OK' : f.status === 'warn' ? 'WARN' : 'BROKEN'
    const req = f.required ? 'required' : 'optional'
    lines.push(`  [${tag}] ${f.field} (${req}): ${f.matched} match(es)`)
  }
  lines.push(report.ok ? 'RESULT: ok' : 'RESULT: FAILED (a required selector is broken)')
  return lines.join('\n')
}
