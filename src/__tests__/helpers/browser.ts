import { chromium } from 'playwright'
import type { Browser } from 'playwright'

/**
 * Probe whether a headless Chromium can actually launch in this environment.
 * Browser-driven tests (extractor, validator) need it; some environments (e.g.
 * a bare WSL without Playwright's system libraries, or CI without
 * `playwright install-deps`) can't launch one. Such tests skip gracefully
 * rather than fail on an environment limitation — install the deps to run them.
 */
export async function browserAvailable(): Promise<boolean> {
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    return true
  } catch {
    return false
  } finally {
    await browser?.close().catch(() => {})
  }
}
