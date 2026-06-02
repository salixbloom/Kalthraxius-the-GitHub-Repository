/**
 * Platform descriptor validator CLI (PLAN.md Phase 8).
 *
 * Dry-scrapes a page with a descriptor's selectors and reports extraction
 * results. Exits 1 if any required selector is broken — usable as a CI gate
 * when adding/editing descriptors.
 *
 * Usage:
 *   node --experimental-strip-types scripts/validate-descriptor.ts <descriptor.json> [--url <url>] [--html <file>]
 *
 *   --url   Fetch this URL (defaults to the descriptor's baseUrl).
 *   --html  Validate against a local HTML file instead of fetching (offline).
 */
import { readFileSync } from 'node:fs'
import { fetch as plainFetch } from '../src/fetcher.ts'
import { validateDescriptor, formatReport } from '../src/descriptor-validator.ts'
import type { PlatformDescriptor } from '../src/types.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const descriptorPath = process.argv[2]
  if (!descriptorPath || descriptorPath.startsWith('--')) {
    console.error('Usage: validate-descriptor <descriptor.json> [--url <url>] [--html <file>]')
    process.exit(2)
  }

  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as PlatformDescriptor

  let html: string
  const htmlFile = arg('--html')
  if (htmlFile) {
    html = readFileSync(htmlFile, 'utf8')
  } else {
    const url = arg('--url') ?? descriptor.baseUrl
    console.error(`Fetching ${url} …`)
    const res = await plainFetch(url, descriptor)
    html = res.html
  }

  const report = await validateDescriptor(html, descriptor)
  console.log(formatReport(report))
  process.exit(report.ok ? 0 : 1)
}

main().catch(err => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(2)
})
