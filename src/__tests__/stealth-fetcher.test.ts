import { describe, it, expect } from 'vitest'
import { jitter, StaticProxyRotator, fetchStealth } from '../stealth-fetcher.js'

describe('jitter', () => {
  it('stays within [min, max]', () => {
    for (let i = 0; i < 1000; i++) {
      const d = jitter(100, 200)
      expect(d).toBeGreaterThanOrEqual(100)
      expect(d).toBeLessThanOrEqual(200)
    }
  })

  it('handles a zero-width range', () => {
    expect(jitter(500, 500)).toBe(500)
  })
})

describe('StaticProxyRotator', () => {
  it('round-robins through the pool', () => {
    const r = new StaticProxyRotator([
      { server: 'http://p1:8080' },
      { server: 'http://p2:8080' },
    ])
    expect(r.next()?.server).toBe('http://p1:8080')
    expect(r.next()?.server).toBe('http://p2:8080')
    expect(r.next()?.server).toBe('http://p1:8080') // wraps
  })

  it('returns null for an empty pool', () => {
    expect(new StaticProxyRotator([]).next()).toBeNull()
  })

  it('passes through credentials', () => {
    const r = new StaticProxyRotator([{ server: 'http://p:8080', username: 'u', password: 'pw' }])
    const got = r.next()
    expect(got?.username).toBe('u')
    expect(got?.password).toBe('pw')
  })
})

/**
 * Live bot-detection check — gated behind RUN_STEALTH=1 because it needs real
 * network + a full browser. Run manually: `RUN_STEALTH=1 npx vitest run stealth`.
 * Asserts navigator.webdriver is masked (the most basic automation tell the
 * stealth plugin should defeat).
 */
const liveIt = process.env['RUN_STEALTH'] === '1' ? it : it.skip

describe('stealth (live, gated)', () => {
  liveIt('masks navigator.webdriver on a real page', async () => {
    // A trivial data: URL that echoes navigator.webdriver into the DOM.
    const probe =
      'data:text/html,' +
      encodeURIComponent('<html><body><div id="wd"></div><script>document.getElementById("wd").textContent=String(navigator.webdriver)</script></body></html>')
    const result = await fetchStealth(probe, { jitterMs: { min: 0, max: 0 } })
    // With the stealth plugin, navigator.webdriver should be false/undefined,
    // not "true".
    expect(result.html).not.toContain('>true<')
  }, 60_000)
})
