import { chromium as chromiumExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { request } from 'undici'
import { getRedirectDispatcher } from './fetcher.js'
import type { FetchResult } from './fetcher.js'
import type { PlatformDescriptor } from './types.js'

/**
 * Hardened fetcher (Phase 8): stealth browser automation, timing jitter, UA
 * rotation, and a proxy-rotation adapter. Reduces bot-detection footprint
 * (risk register: "Bot detection breaking scrapers"). The plain fetcher.ts
 * remains for unauthenticated/simple fetches; this is the evasion-hardened path.
 *
 * The stealth plugin (puppeteer-extra-plugin-stealth, driven through
 * playwright-extra) patches the well-known automation tells
 * (navigator.webdriver, headless UA, missing plugins, WebGL vendor, etc.).
 */

// Register the stealth plugin once on the shared chromium-extra instance.
let stealthRegistered = false
function ensureStealth(): void {
  if (stealthRegistered) return
  chromiumExtra.use(StealthPlugin())
  stealthRegistered = true
}

/**
 * Supplies an outbound proxy per request, enabling IP rotation to spread the
 * scraping footprint (PLAN.md Phase 8: "proxy rotation adapter"). Implement
 * against a proxy pool/provider; return null to fetch directly.
 */
export interface ProxyRotator {
  /** Return the next proxy server (e.g. "http://user:pass@host:port"), or null. */
  next(): { server: string; username?: string; password?: string } | null
}

/** Round-robins a static list of proxy servers. Good default for a fixed pool. */
export class StaticProxyRotator implements ProxyRotator {
  private servers: Array<{ server: string; username?: string; password?: string }>
  private i = 0
  constructor(servers: Array<{ server: string; username?: string; password?: string }>) {
    this.servers = servers
  }
  next(): { server: string; username?: string; password?: string } | null {
    if (this.servers.length === 0) return null
    const s = this.servers[this.i % this.servers.length]!
    this.i++
    return s
  }
}

// A small pool of realistic desktop UA strings to rotate through.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
]

export interface StealthFetchOptions {
  /** Proxy rotator; if omitted, fetches go direct. */
  proxies?: ProxyRotator
  /** Min/max random delay (ms) applied before navigating, to avoid robotic cadence. */
  jitterMs?: { min: number; max: number }
  /** Override the UA pool. */
  userAgents?: string[]
  /** Navigation timeout (ms). Default 30s. */
  timeoutMs?: number
}

const DEFAULT_JITTER = { min: 250, max: 1500 }

/** Random integer in [min, max]. */
export function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

/**
 * Fetch a URL through a stealth-patched headless browser, applying timing
 * jitter, a rotated UA, and (optionally) a rotated proxy.
 */
export async function fetchStealth(url: string, opts: StealthFetchOptions = {}): Promise<FetchResult> {
  ensureStealth()
  const userAgents = opts.userAgents ?? USER_AGENTS
  const jit = opts.jitterMs ?? DEFAULT_JITTER
  const timeout = opts.timeoutMs ?? 30_000
  const proxy = opts.proxies?.next() ?? undefined

  const browser = await chromiumExtra.launch({
    headless: true,
    proxy: proxy ? { server: proxy.server } : undefined,
  })
  try {
    const context = await browser.newContext({
      userAgent: pick(userAgents),
      ...(proxy?.username
        ? { httpCredentials: { username: proxy.username, password: proxy.password ?? '' } }
        : {}),
    })
    const page = await context.newPage()

    // Human-ish pause before navigation.
    await sleep(jitter(jit.min, jit.max))

    const response = await page.goto(url, { waitUntil: 'networkidle', timeout })
    const html = await page.content()
    return {
      html,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 200,
    }
  } finally {
    await browser.close()
  }
}

/**
 * Drop-in hardened replacement for fetcher.fetch: stealth-browser for
 * browser-mode descriptors, jittered undici for http-mode. Same FetchResult
 * shape, so callers swap without other changes.
 */
export async function fetchHardened(
  url: string,
  descriptor: Pick<PlatformDescriptor, 'fetcherMode'>,
  opts: StealthFetchOptions = {},
): Promise<FetchResult> {
  const jit = opts.jitterMs ?? DEFAULT_JITTER
  await sleep(jitter(jit.min, jit.max))

  if (descriptor.fetcherMode === 'browser') {
    return fetchStealth(url, opts)
  }

  const userAgents = opts.userAgents ?? USER_AGENTS
  const { statusCode, body, headers } = await request(url, {
    headers: {
      'User-Agent': pick(userAgents),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    dispatcher: getRedirectDispatcher(),
  })
  const html = await body.text()
  const finalUrl = (headers['location'] as string | undefined) ?? url
  return { html, finalUrl, statusCode }
}
