import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', '..', 'data')

export interface SkillEntry {
  id: string
  label: string
  aliases: string[]
}

interface TaxonomyFile {
  version: number
  source: string
  skills: SkillEntry[]
}

export interface Taxonomy {
  /** All skills, deduped by id. */
  entries: SkillEntry[]
  /** Lowercased surface form → entry. Covers labels and every alias. */
  bySurface: Map<string, SkillEntry>
  version: number
}

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

function loadFile(path: string): TaxonomyFile {
  return JSON.parse(readFileSync(path, 'utf8')) as TaxonomyFile
}

/**
 * Builds the skills taxonomy. Always loads the hand-curated seed; if a
 * generated ESCO file exists at data/skills-esco.json (produced by
 * `npm run download-esco-skills`), it is merged in. Curated entries win on id
 * collision so our canonical labels/aliases are authoritative.
 *
 * The ESCO merge is therefore opt-in by file presence — no network at runtime,
 * deterministic given the committed seed.
 */
export function buildTaxonomy(): Taxonomy {
  const seed = loadFile(join(DATA_DIR, 'skills-seed.json'))
  const byId = new Map<string, SkillEntry>()

  // ESCO first (lower priority), then seed overrides on id collision.
  const escoPath = join(DATA_DIR, 'skills-esco.json')
  if (existsSync(escoPath)) {
    for (const e of loadFile(escoPath).skills) byId.set(e.id, e)
  }
  for (const e of seed.skills) byId.set(e.id, e)

  const entries = [...byId.values()]
  const bySurface = new Map<string, SkillEntry>()
  for (const entry of entries) {
    bySurface.set(normalize(entry.label), entry)
    for (const alias of entry.aliases) bySurface.set(normalize(alias), entry)
  }

  return { entries, bySurface, version: seed.version }
}

export { normalize }
