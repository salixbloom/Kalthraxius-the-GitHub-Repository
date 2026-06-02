import type { EnrichedField, SalaryExtraction, SalaryPeriod } from '../types.js'

/**
 * Salary extraction via regex. The plan targets <10% null rate on postings
 * that visibly contain a range, so we cover the common formats:
 *   - ranges: "$120,000 - $150,000", "120k–150k", "£90k to £110k"
 *   - single values: "$120,000", "150k"
 *   - k-notation: "120k", "$120K"
 *   - hourly/period: "$50/hr", "$50 per hour", "$120k/year"
 *   - currencies: $, £, €, and USD/GBP/EUR/CAD/AUD codes
 *
 * Anything we can't parse confidently returns value: null, confidence: 0.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
}

const CURRENCY_CODES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NZD', 'INR']

// A money token, with three positional capture groups: symbol, number, suffix.
// Kept name-free so it can be concatenated for the range pattern without
// colliding capture-group names.
const MONEY = String.raw`([$£€¥])?\s?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kKmM])?`

const PERIOD_PATTERNS: Array<[RegExp, SalaryPeriod]> = [
  [/\b(?:per\s+hour|hourly|\/\s?hr?|an\s+hour|p\/?h)\b/i, 'hour'],
  [/\b(?:per\s+day|daily|\/\s?day|a\s+day)\b/i, 'day'],
  [/\b(?:per\s+week|weekly|\/\s?wk|\/\s?week|a\s+week)\b/i, 'week'],
  [/\b(?:per\s+month|monthly|\/\s?mo|\/\s?month|a\s+month)\b/i, 'month'],
  [/\b(?:per\s+(?:year|annum)|annually|yearly|\/\s?yr|\/\s?year|p\.?a\.?)\b/i, 'year'],
]

function parseAmount(num: string, suffix: string | undefined): number {
  const n = Number(num.replace(/[,\s]/g, ''))
  if (suffix && /[kK]/.test(suffix)) return n * 1_000
  if (suffix && /[mM]/.test(suffix)) return n * 1_000_000
  return n
}

function detectCurrency(text: string, symbol: string | undefined): string | null {
  if (symbol && CURRENCY_SYMBOLS[symbol]) return CURRENCY_SYMBOLS[symbol]
  const code = CURRENCY_CODES.find(c => new RegExp(`\\b${c}\\b`).test(text))
  return code ?? null
}

function detectPeriod(text: string): SalaryPeriod | null {
  for (const [re, period] of PERIOD_PATTERNS) {
    if (re.test(text)) return period
  }
  return null
}

/**
 * Heuristic: an amount under this is implausible as an annual figure, so when
 * no explicit period is present we treat small numbers as hourly. (e.g. "$55"
 * with no /yr is an hourly rate; "$120,000" is annual.)
 */
const HOURLY_THRESHOLD = 1_000

export function extractSalary(...sources: Array<string | null | undefined>): EnrichedField<SalaryExtraction | null> {
  const text = sources.filter(Boolean).join('\n')
  if (!text.trim()) return { value: null, confidence: 0 }

  // Range: two money tokens joined by a dash/"to".
  const rangeRe = new RegExp(`${MONEY}\\s*(?:-|–|—|to|\\.\\.)\\s*${MONEY}`, 'i')
  const m = text.match(rangeRe)
  if (m) {
    const [, sym1, num1, suf1, sym2, num2, suf2] = m
    // If the lower bound lacks a k/m suffix but the upper has one, inherit it
    // ("120 - 150k" means 120k–150k).
    const effSuf1 = suf1 || suf2
    const min = parseAmount(num1!, effSuf1)
    const max = parseAmount(num2!, suf2)
    const currency = detectCurrency(text, sym1 || sym2)
    const period = detectPeriod(text) ?? (max < HOURLY_THRESHOLD ? 'hour' : 'year')
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)
    return {
      value: { min: lo, max: hi, currency, period },
      confidence: currency ? 0.95 : 0.8,
    }
  }

  // Single value.
  const singleRe = new RegExp(MONEY, 'i')
  const sm = text.match(singleRe)
  if (sm && /\d/.test(sm[2] ?? '')) {
    const [, sym, num, suf] = sm
    const amount = parseAmount(num!, suf)
    // Guard against matching stray numbers (years, counts) — require either a
    // currency symbol/code, a k/m suffix, or an explicit period nearby.
    const currency = detectCurrency(text, sym)
    const period = detectPeriod(text)
    const looksLikeMoney = Boolean(sym) || Boolean(suf) || Boolean(currency) || Boolean(period)
    if (!looksLikeMoney) return { value: null, confidence: 0 }
    const resolvedPeriod = period ?? (amount < HOURLY_THRESHOLD ? 'hour' : 'year')
    return {
      value: { min: amount, max: amount, currency, period: resolvedPeriod },
      // Single value is less informative than a range; cap confidence lower.
      confidence: currency ? 0.7 : 0.55,
    }
  }

  return { value: null, confidence: 0 }
}
