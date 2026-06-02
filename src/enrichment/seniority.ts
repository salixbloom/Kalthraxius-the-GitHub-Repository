import type { EnrichedField, SeniorityLevel } from '../types.js'

/**
 * Rule-based seniority classification. Per the plan: title keyword matching is
 * the PRIMARY signal (high confidence); description patterns are SECONDARY
 * (lower confidence, only consulted when the title is silent).
 *
 * Verification target: >90% accuracy on postings with an explicit title signal.
 */

interface Rule {
  level: SeniorityLevel
  /** Matched against the title (primary). Word-boundary anchored. */
  title: RegExp
}

// Order matters: the FIRST matching rule wins, so list more-senior / more-
// specific levels before the generic ones. "Senior staff engineer" should
// resolve to staff, not senior; "engineering manager" to manager, not mid.
const RULES: Rule[] = [
  { level: 'executive', title: /\b(?:cto|ceo|cfo|coo|cio|chief|vp|vice\s+president|head\s+of)\b/i },
  { level: 'director', title: /\bdirector\b/i },
  { level: 'principal', title: /\bprincipal\b/i },
  { level: 'staff', title: /\bstaff\b/i },
  { level: 'lead', title: /\b(?:lead|leader|tech\s+lead|team\s+lead)\b/i },
  { level: 'manager', title: /\b(?:manager|mgr|management)\b/i },
  { level: 'senior', title: /\b(?:senior|sr\.?|snr)\b/i },
  { level: 'junior', title: /\b(?:junior|jr\.?|entry[\s-]?level|associate|graduate|grad)\b/i },
  { level: 'intern', title: /\b(?:intern|internship|trainee|apprentice|co[\s-]?op)\b/i },
  { level: 'mid', title: /\b(?:mid[\s-]?level|intermediate|mid)\b/i },
]

// Secondary signals: phrases in the description that imply a level when the
// title says nothing. Lower confidence than a title hit.
const DESCRIPTION_RULES: Array<{ level: SeniorityLevel; re: RegExp }> = [
  { level: 'senior', re: /\b(?:senior|seasoned|highly experienced|deep expertise)\b/i },
  { level: 'lead', re: /\b(?:lead a team|mentor|technical leadership|lead the)\b/i },
  { level: 'junior', re: /\b(?:entry[\s-]?level|early career|no experience required|0-2 years|recent graduate)\b/i },
  { level: 'intern', re: /\b(?:internship|summer intern|currently enrolled)\b/i },
]

export function extractSeniority(
  title: string | null | undefined,
  description?: string | null,
): EnrichedField<SeniorityLevel | null> {
  // Primary: title keyword match.
  if (title) {
    for (const rule of RULES) {
      if (rule.title.test(title)) {
        return { value: rule.level, confidence: 0.95 }
      }
    }
  }

  // Secondary: description patterns.
  if (description) {
    for (const rule of DESCRIPTION_RULES) {
      if (rule.re.test(description)) {
        return { value: rule.level, confidence: 0.6 }
      }
    }
  }

  // A plain title like "Software Engineer" with no modifier is conventionally
  // mid-level, but that's an inference, not a signal — keep confidence low so
  // downstream consumers can treat it as a soft default.
  if (title && /\b(?:engineer|developer|programmer|analyst|designer|scientist)\b/i.test(title)) {
    return { value: 'mid', confidence: 0.4 }
  }

  return { value: null, confidence: 0 }
}
