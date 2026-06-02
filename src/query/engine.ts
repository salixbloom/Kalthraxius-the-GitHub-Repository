import type { IndexedJob } from '../aggregator/store.js'
import type { QueryProfile, ScoredHit } from './types.js'

/**
 * The query pipeline: hard filter → score (stack overlap) → rank (freshness).
 * Pure and synchronous over an in-memory candidate set, so an aggregator runs
 * it against its own store and a client runs it (again) over merged fan-out
 * results.
 *
 * Design principle: the user controls what they see. Filters only apply where
 * the user set a bound; absent bound = no filtering on that axis. Skills never
 * exclude — they only score.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const FRESHNESS_PENALTY_DAYS = 60

export function runQuery(candidates: IndexedJob[], profile: QueryProfile): ScoredHit[] {
  const includeUnknown = profile.includeUnknown ?? true
  const limit = profile.limit ?? 50
  const now = Date.now()

  const hits: ScoredHit[] = []
  for (const candidate of candidates) {
    const verdict = passesFilter(candidate, profile, includeUnknown)
    if (!verdict.pass) continue

    const { matchedSkills, overlapScore } = scoreStack(candidate, profile.stack)
    const freshness = freshnessScore(candidate, now)
    // Stack overlap is the primary signal; freshness breaks ties and decays old
    // postings. Weighted so a strong skill match always outranks pure recency.
    const score = overlapScore * 10 + freshness

    hits.push({
      contentHash: candidate.job.contentHash,
      job: candidate,
      score,
      matchedSkills,
      qualification: verdict.assumed ? 'assumed' : 'confirmed',
    })
  }

  hits.sort((a, b) => b.score - a.score || a.contentHash.localeCompare(b.contentHash))
  return hits.slice(0, limit)
}

interface Verdict {
  pass: boolean
  /** True if it only passed because a filtered field was null (includeUnknown). */
  assumed: boolean
}

function passesFilter(c: IndexedJob, profile: QueryProfile, includeUnknown: boolean): Verdict {
  let assumed = false

  // YOE: hide jobs requiring MORE than the user's chosen ceiling.
  if (profile.yoeMax !== undefined) {
    const required = c.enrichment.yoe.value
    if (required === null) {
      if (!includeUnknown) return { pass: false, assumed: false }
      assumed = true
    } else if (required > profile.yoeMax) {
      return { pass: false, assumed: false }
    }
  }

  // Salary: hide jobs whose top-of-range is below the floor.
  if (profile.salaryFloor !== undefined) {
    const salary = c.enrichment.salary.value
    const max = salary?.max ?? salary?.min ?? null
    if (max === null) {
      if (!includeUnknown) return { pass: false, assumed: false }
      assumed = true
    } else if (max < profile.salaryFloor) {
      return { pass: false, assumed: false }
    }
  }

  // Location: location is a raw string on the job (not enriched), so it's never
  // "unknown" in the null sense — but an empty string is treated as unknown.
  if (profile.location !== undefined) {
    const loc = c.job.location?.trim() ?? ''
    if (loc === '') {
      if (!includeUnknown) return { pass: false, assumed: false }
      assumed = true
    } else if (!locationMatches(loc, profile.location)) {
      return { pass: false, assumed: false }
    }
  }

  return { pass: true, assumed }
}

function locationMatches(jobLocation: string, want: string): boolean {
  const job = jobLocation.toLowerCase()
  const target = want.toLowerCase().trim()
  if (target === 'remote') return /\bremote\b/.test(job)
  // Remote jobs match any location query (you can work from anywhere).
  if (/\bremote\b/.test(job)) return true
  // Substring match either direction handles "Seattle" vs "Seattle, WA".
  return job.includes(target) || target.includes(job)
}

function scoreStack(c: IndexedJob, stack: string[]): { matchedSkills: string[]; overlapScore: number } {
  if (stack.length === 0) return { matchedSkills: [], overlapScore: 0 }
  const jobSkillIds = new Set(c.enrichment.skills.map(s => s.id))
  const wanted = stack.map(s => s.toLowerCase())
  const matched = wanted.filter(id => jobSkillIds.has(id))
  // Normalised overlap (0–1): fraction of the user's stack the job covers.
  return { matchedSkills: matched, overlapScore: matched.length / stack.length }
}

/**
 * Freshness in [0, 1]: 1.0 for a posting scraped now, decaying linearly to 0 at
 * FRESHNESS_PENALTY_DAYS. Older than that floors at 0 (the "60+ day penalty"),
 * so a 2-day posting outranks an otherwise-identical 90-day one.
 */
function freshnessScore(c: IndexedJob, now: number): number {
  const ageDays = (now - c.job.scrapedAt) / DAY_MS
  if (ageDays <= 0) return 1
  if (ageDays >= FRESHNESS_PENALTY_DAYS) return 0
  return 1 - ageDays / FRESHNESS_PENALTY_DAYS
}
