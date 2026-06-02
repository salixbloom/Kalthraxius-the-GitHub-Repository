import type { EnrichedField } from '../types.js'

/**
 * Years-of-experience extraction via regex. Plan policy: ambiguous → null.
 *
 * We extract the *minimum required* years. Common phrasings:
 *   - "5+ years of experience"
 *   - "3-5 years experience"        → 3 (the floor)
 *   - "at least 4 years"
 *   - "minimum of 7 years"
 *   - "5 yrs+"
 *   - "two years of experience"     → spelled-out small numbers
 *
 * We deliberately do NOT match bare "experience" with no number, nor
 * "years" attached to unrelated nouns (e.g. "5 years ago"), to keep the null
 * policy honest.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

function toNumber(token: string): number | null {
  const lower = token.toLowerCase()
  if (lower in WORD_NUMBERS) return WORD_NUMBERS[lower]!
  const n = Number(token)
  return Number.isFinite(n) ? n : null
}

const NUM = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`

// Ordered by specificity — first confident match wins.
const PATTERNS: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => number | null; conf: number }> = [
  // Range "3-5 years [of] experience" → floor.
  {
    re: new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*(?:\\+)?\\s*(?:years?|yrs?)\\b[^.]{0,30}?\\bexperience`, 'i'),
    pick: m => toNumber(m[1]!),
    conf: 0.9,
  },
  // "5+ years ... experience" / "5 years ... experience"
  {
    re: new RegExp(`${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b[^.]{0,30}?\\bexperience`, 'i'),
    pick: m => toNumber(m[1]!),
    conf: 0.9,
  },
  // "experience: 5+ years" (reversed order)
  {
    re: new RegExp(`\\bexperience[^.]{0,30}?${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'i'),
    pick: m => toNumber(m[1]!),
    conf: 0.85,
  },
  // "at least / minimum (of) 5 years"
  {
    re: new RegExp(`(?:at least|minimum(?:\\s+of)?|min\\.?)\\s*${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'i'),
    pick: m => toNumber(m[1]!),
    conf: 0.85,
  },
  // Bare "5+ years" / "5 yrs+" — weaker, no "experience" anchor.
  {
    re: new RegExp(`${NUM}\\s*(?:\\+\\s*)?(?:years?|yrs?)\\s*\\+?`, 'i'),
    pick: m => toNumber(m[1]!),
    conf: 0.6,
  },
]

export function extractYoe(...sources: Array<string | null | undefined>): EnrichedField<number | null> {
  const text = sources.filter(Boolean).join('\n')
  if (!text.trim()) return { value: null, confidence: 0 }

  for (const { re, pick, conf } of PATTERNS) {
    const m = text.match(re)
    if (m) {
      const value = pick(m)
      // Sanity bound: 0–50 years. Anything outside is a mis-parse.
      if (value !== null && value >= 0 && value <= 50) {
        return { value, confidence: conf }
      }
    }
  }
  return { value: null, confidence: 0 }
}
