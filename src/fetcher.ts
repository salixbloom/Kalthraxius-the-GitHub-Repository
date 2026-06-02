import { request } from 'undici'
import { chromium } from 'playwright'
import type { PlatformDescriptor } from './types.js'

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
  // maxRedirections is a valid runtime option on undici's request() but is
  // absent from the current overload's type; assert through the known shape.
  const { statusCode, body, headers } = await request(url, {
    headers: DEFAULT_HEADERS,
    maxRedirections: 5,
  } as Parameters<typeof request>[1])
  const html = await body.text()
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
