import type { SkillMatch } from '../types.js'
import { buildTaxonomy, normalize, type Taxonomy } from './taxonomy.js'

/**
 * Skill extraction against the curated (+ optional ESCO) taxonomy.
 *
 * Strategy:
 *   1. Generate 1–3 word n-grams from the text.
 *   2. Exact surface match against the taxonomy index (label or any alias) →
 *      confidence 1.0.
 *   3. For multi-char single tokens with no exact hit, bounded fuzzy match
 *      (Levenshtein ≤ 1 for len≥5) against single-word surfaces → confidence
 *      scaled by edit distance. Catches typos like "kubernets", "javascrpt".
 *
 * Plan target: >80% recall on explicit bullet-pointed skills sections.
 */

let cached: Taxonomy | null = null
function taxonomy(): Taxonomy {
  if (!cached) cached = buildTaxonomy()
  return cached
}

/** For tests / re-enrichment after a taxonomy file change. */
export function resetTaxonomyCache(): void {
  cached = null
}

const TOKEN_RE = /[a-z0-9](?:[a-z0-9+.#-]*[a-z0-9+#])?/gi

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? []
}

/** Bounded Levenshtein: returns the true distance, or `bound + 1` if it exceeds bound. */
function levenshtein(a: string, b: string, bound: number): number {
  if (Math.abs(a.length - b.length) > bound) return bound + 1
  const prev = new Array(b.length + 1)
  const curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > bound) return bound + 1
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

export function extractSkills(...sources: Array<string | null | undefined>): SkillMatch[] {
  const text = sources.filter(Boolean).join('\n')
  if (!text.trim()) return []

  const tax = taxonomy()
  const tokens = tokenize(text)
  // id → best confidence seen
  const found = new Map<string, SkillMatch>()

  const record = (id: string, label: string, confidence: number) => {
    const existing = found.get(id)
    if (!existing || confidence > existing.confidence) {
      found.set(id, { id, label, confidence })
    }
  }

  // 1–3 word n-grams, exact match (longest preferred via confidence tie-break).
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const surface = tokens.slice(i, i + n).join(' ')
      const hit = tax.bySurface.get(surface)
      if (hit) record(hit.id, hit.label, 1.0)
    }
  }

  // Fuzzy pass over single tokens that had no exact hit. Only for reasonably
  // long tokens to avoid matching short noise (e.g. "go", "r", "c").
  const singleWordSurfaces = [...tax.bySurface.keys()].filter(s => !s.includes(' ') && s.length >= 5)
  for (const tok of new Set(tokens)) {
    if (tok.length < 5) continue
    if (tax.bySurface.has(tok)) continue // already exact-matched
    let best: { entry: ReturnType<Taxonomy['bySurface']['get']>; dist: number } | null = null
    for (const surface of singleWordSurfaces) {
      const bound = surface.length >= 8 ? 2 : 1
      const dist = levenshtein(tok, surface, bound)
      if (dist <= bound && (!best || dist < best.dist)) {
        best = { entry: tax.bySurface.get(surface), dist }
        if (dist === 1) break
      }
    }
    if (best?.entry) {
      // confidence: 0.85 for distance 1, 0.7 for distance 2.
      const confidence = best.dist === 1 ? 0.85 : 0.7
      record(best.entry.id, best.entry.label, confidence)
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label))
}
