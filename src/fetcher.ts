import { request, getGlobalDispatcher, interceptors } from 'undici'
import { chromium } from 'playwright'
import type { Dispatcher } from 'undici'
import type { PlatformDescriptor } from './types.js'

// undici v6+ removed the `maxRedirections` request option; redirect following
// is now an interceptor composed onto a dispatcher. Build one once and reuse it.
const MAX_REDIRECTS = 5
let redirectDispatcher: Dispatcher | undefined

/**
 * A shared undici dispatcher that follows up to MAX_REDIRECTS redirects via the
 * redirect interceptor. Exported so the stealth fetcher reuses the same config.
 */
export function getRedirectDispatcher(): Dispatcher {
  redirectDispatcher ??= getGlobalDispatcher().compose(
    interceptors.redirect({ maxRedirections: MAX_REDIRECTS }),
  )
  return redirectDispatcher
}

export interface FetchResult {
  html: string
  finalUrl: string
  statusCode: number
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
}

async function fetchHttp(url: string): Promise<FetchResult> {
  const { statusCode, body, headers } = await request(url, {
    headers: DEFAULT_HEADERS,
    dispatcher: getRedirectDispatcher(),
  })
  const html = await body.text()
  // The redirect interceptor follows up to MAX_REDIRECTS hops, so a 2xx
  // response carries no `location`. If a redirect was NOT followed (e.g. the
  // cap was hit) the final `location` header still points at the next hop;
  // otherwise the requested URL is the effective final URL.
  const finalUrl = (headers['location'] as string | undefined) ?? url
  return { html, finalUrl, statusCode }
}

async function fetchBrowser(url: string): Promise<FetchResult> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders(DEFAULT_HEADERS)
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
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

export async function fetch(
  url: string,
  descriptor: Pick<PlatformDescriptor, 'fetcherMode'>,
): Promise<FetchResult> {
  if (descriptor.fetcherMode === 'http') {
    return fetchHttp(url)
  }
  return fetchBrowser(url)
}
