/**
 * Build step: download the ESCO skills classification, trim it to the shape our
 * taxonomy loader consumes, and write data/skills-esco.json. The file is merged
 * (lower priority than the hand-curated seed) by buildTaxonomy() at runtime, so
 * running this raises skill recall toward the plan's >80% target without
 * touching the offline-default path.
 *
 * Run: `npm run download-esco-skills`
 *
 * Config (env vars, all optional):
 *   ESCO_CSV_URL   Direct URL to an ESCO `skills_en.csv` (preferredLabel,
 *                  altLabels, conceptUri columns). Required unless ESCO_CSV_FILE.
 *   ESCO_CSV_FILE  Local path to a pre-downloaded ESCO skills CSV. Takes
 *                  precedence over the URL (useful in offline/CI environments
 *                  that vendor the CSV themselves).
 *   ESCO_MAX       Cap on number of skills written (default: no cap).
 *
 * Output is gitignored — it's a generated artifact, not source.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'data', 'skills-esco.json')

interface SkillEntry {
  id: string
  label: string
  aliases: string[]
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields with embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* skip */ }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

async function loadCsv(): Promise<string> {
  const file = process.env['ESCO_CSV_FILE']
  if (file) {
    if (!existsSync(file)) throw new Error(`ESCO_CSV_FILE not found: ${file}`)
    console.log(`Reading ESCO CSV from file: ${file}`)
    return readFileSync(file, 'utf8')
  }
  const url = process.env['ESCO_CSV_URL']
  if (!url) {
    throw new Error(
      'Set ESCO_CSV_URL (or ESCO_CSV_FILE) to an ESCO skills_en.csv. ' +
        'Download the ESCO classification bundle from https://esco.ec.europa.eu/en/use-esco/download',
    )
  }
  console.log(`Downloading ESCO CSV from: ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  return res.text()
}

function columnIndex(header: string[], candidates: string[]): number {
  const lower = header.map(h => h.toLowerCase().trim())
  for (const c of candidates) {
    const idx = lower.indexOf(c)
    if (idx !== -1) return idx
  }
  return -1
}

async function main(): Promise<void> {
  const csv = await loadCsv()
  const rows = parseCsv(csv)
  if (rows.length < 2) throw new Error('ESCO CSV appears empty or headerless.')

  const header = rows[0]!
  const labelIdx = columnIndex(header, ['preferredlabel', 'preferred label'])
  const altIdx = columnIndex(header, ['altlabels', 'alt labels', 'alternative labels'])
  const uriIdx = columnIndex(header, ['concepturi', 'uri'])
  if (labelIdx === -1) throw new Error('Could not find a preferredLabel column in the ESCO CSV.')

  const max = process.env['ESCO_MAX'] ? Number(process.env['ESCO_MAX']) : Infinity
  const seen = new Set<string>()
  const skills: SkillEntry[] = []

  for (let i = 1; i < rows.length && skills.length < max; i++) {
    const r = rows[i]!
    const label = (r[labelIdx] ?? '').trim()
    if (!label) continue
    // ESCO concept URIs end in a UUID; prefer a stable slug from the URI tail,
    // fall back to the label slug.
    const uri = uriIdx !== -1 ? (r[uriIdx] ?? '') : ''
    const uriTail = uri.split('/').pop() ?? ''
    const id = `esco-${uriTail || slugify(label)}`
    if (seen.has(id)) continue
    seen.add(id)

    const aliases =
      altIdx !== -1
        ? (r[altIdx] ?? '')
            .split(/\r?\n|\|/)
            .map(s => s.trim())
            .filter(Boolean)
        : []

    skills.push({ id, label, aliases })
  }

  const payload = { version: 1, source: 'esco', skills }
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 0) + '\n', 'utf8')
  console.log(`Wrote ${skills.length} ESCO skills to ${OUT_PATH}`)
}

main().catch(err => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
