import { ENRICHMENT_SCHEMA_VERSION } from '../types.js'
import type { Enrichment, RawJob } from '../types.js'
import { extractSalary } from './salary.js'
import { extractYoe } from './yoe.js'
import { extractSeniority } from './seniority.js'
import { extractSkills } from './skills.js'

/**
 * Runs all four extractors over a raw job and assembles a versioned
 * `Enrichment`. Pure and synchronous — CPU-only, no I/O — so it can be driven
 * by the async worker in tight batches without yielding mid-job.
 *
 * Field source precedence:
 *   - salary: the dedicated `salary` field first, then the description.
 *   - yoe:    title + description (YOE rarely appears in titles, but cheap).
 *   - seniority: title primary, description secondary (per plan).
 *   - skills: title + description.
 */
export function enrichJob(job: RawJob): Enrichment {
  return {
    contentHash: job.contentHash,
    salary: extractSalary(job.salary, job.description),
    yoe: extractYoe(job.title, job.description),
    seniority: extractSeniority(job.title, job.description),
    skills: extractSkills(job.title, job.description),
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    enrichedAt: Date.now(),
  }
}
