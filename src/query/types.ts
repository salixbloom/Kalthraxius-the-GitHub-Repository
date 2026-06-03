import type { IndexedJob } from '../aggregator/store.js'

/**
 * A user query. The guiding principle (per project owner): the USER controls
 * what they see — we serve their intent, we don't gatekeep. Every filter bound
 * is optional; an absent bound means "don't filter on this axis".
 *
 * - `stack`     — the user's skills. Affects SCORE only, never excludes a job.
 * - `yoeMax`    — if set, hide jobs requiring MORE than this many years. The
 *                 user sets it to their real YOE, or higher ("show me 5+"), or
 *                 omits it ("show everything"). It is a user-chosen ceiling, not
 *                 a cap we infer from their experience.
 * - `salaryFloor` — if set, hide jobs whose salary max is below it.
 * - `location`  — if set, hide jobs that don't match (see locationMatches).
 *                 'remote' matches remote postings.
 * - `includeUnknown` — default true. When true, a job whose enriched field is
 *                 null passes filters that touch that field (don't punish a job
 *                 for our extraction gap). When false, a null on ANY filtered
 *                 field excludes the job (the user opted to hide missing data).
 */
export interface QueryProfile {
  stack: string[]
  yoeMax?: number
  salaryFloor?: number
  location?: string
  includeUnknown?: boolean
  /** Max results to return. Default 50. */
  limit?: number
}

/** A job that passed the hard filter, with its score and a match explanation. */
export interface ScoredHit {
  contentHash: string
  job: IndexedJob
  /** Composite score used for ordering (higher = better). */
  score: number
  /** Skill ids from the profile stack that the job matched (drives the score). */
  matchedSkills: string[]
  /** Relative posting age for the result, when a posted date or scrape time is present. */
  postedAgo: {
    text: string
    days: number
    source: 'postedAt' | 'scrapedAt'
  } | null
  /**
   * Whether qualification is positively confirmed or merely assumed because a
   * filtered field was null and includeUnknown let it pass. Lets a UI badge or
   * re-sort "assumed" hits without us hiding them.
   */
  qualification: 'confirmed' | 'assumed'
}

export interface QueryResult {
  hits: ScoredHit[]
}
