import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../rate-limiter.js'

/**
 * Drives the limiter with a virtual clock and a no-real-wait sleep, so we can
 * assert the *requested* wait durations deterministically and instantly.
 */
function harness(start = 0) {
  let nowMs = start
  const waits: number[] = []
  const limiter = new RateLimiter({
    now: () => nowMs,
    sleep: async (ms: number) => {
      waits.push(ms)
      nowMs += ms // advancing the clock simulates the wait elapsing
    },
  })
  return { limiter, waits, advance: (ms: number) => (nowMs += ms) }
}

describe('RateLimiter', () => {
  it('does not throttle the first request', async () => {
    const { limiter, waits } = harness()
    await limiter.acquire('gh', 60)
    expect(waits).toEqual([]) // no wait on the first acquire
  })

  it('spaces subsequent requests by 60000/rpm', async () => {
    const { limiter, waits } = harness()
    // 60/min → 1000ms interval.
    await limiter.acquire('gh', 60) // t=0, no wait
    await limiter.acquire('gh', 60) // must wait ~1000ms
    await limiter.acquire('gh', 60) // another ~1000ms
    expect(waits).toEqual([1000, 1000])
  })

  it('honors a slower rate (20/min → 3000ms interval)', async () => {
    const { limiter, waits } = harness()
    await limiter.acquire('gh', 20)
    await limiter.acquire('gh', 20)
    expect(waits).toEqual([3000])
  })

  it('does not wait when enough time has already passed', async () => {
    const { limiter, waits, advance } = harness()
    await limiter.acquire('gh', 60) // reserves next slot at t=1000
    advance(1500) // real time moves past the slot
    await limiter.acquire('gh', 60) // already allowed → no wait
    expect(waits).toEqual([])
  })

  it('keeps separate keys independent', async () => {
    const { limiter, waits } = harness()
    await limiter.acquire('greenhouse', 60)
    await limiter.acquire('lever', 60) // different platform → not throttled by greenhouse
    expect(waits).toEqual([])
  })

  it('treats rpm <= 0 (or non-finite) as "no limit"', async () => {
    const { limiter, waits } = harness()
    await limiter.acquire('gh', 0)
    await limiter.acquire('gh', 0)
    await limiter.acquire('gh', -5)
    await limiter.acquire('gh', Infinity)
    expect(waits).toEqual([])
  })

  it('serializes concurrent acquires for the same key (no burst slips through)', async () => {
    // Frozen clock: concurrent acquires all read t=0 and must reserve distinct,
    // cumulatively-spaced slots. (A real Date.now() wouldn't jump mid-flight, so
    // here sleep does NOT advance the clock.)
    const waits: number[] = []
    const limiter = new RateLimiter({
      now: () => 0,
      sleep: async (ms: number) => {
        waits.push(ms)
      },
    })
    await Promise.all([
      limiter.acquire('gh', 60),
      limiter.acquire('gh', 60),
      limiter.acquire('gh', 60),
    ])
    // First is free (0); the next two are 1000 and 2000 from t=0.
    expect(waits.sort((a, b) => a - b)).toEqual([1000, 2000])
  })
})
