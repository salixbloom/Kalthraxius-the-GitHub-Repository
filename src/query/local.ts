import { runQuery } from './engine.js'
import type { AggregatorStore } from '../aggregator/store.js'
import type { QueryProfile, ScoredHit } from './types.js'

/**
 * Run a query against a single aggregator's local store. Pulls a bounded
 * candidate set (newest-first) and runs the filter → score → rank pipeline.
 *
 * `candidateCap` bounds how many stored jobs the engine scans — a safety valve
 * for very large stores. It's deliberately larger than the result `limit` so
 * ranking still has room to work; freshness ordering from the store means the
 * freshest candidates are always considered.
 */
export function queryLocal(
  store: AggregatorStore,
  profile: QueryProfile,
  candidateCap = 5_000,
): ScoredHit[] {
  const candidates = store.all(candidateCap)
  return runQuery(candidates, profile)
}
