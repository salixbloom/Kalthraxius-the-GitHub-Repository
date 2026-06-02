import { describe, it, expect } from 'vitest'
import { validateKalthraxiusRecord, MAX_RECORD_VALUE_BYTES } from '../dht-validator.js'
import { sha256 } from '../hasher.js'

const enc = new TextEncoder()
const validKey = enc.encode(`/kalthraxius/${sha256('some-target')}`)

async function rejects(key: Uint8Array, value: Uint8Array): Promise<boolean> {
  try {
    await validateKalthraxiusRecord(key, value)
    return false
  } catch {
    return true
  }
}

describe('validateKalthraxiusRecord — accepts legitimate records', () => {
  it('accepts a scrape-claim shape', async () => {
    const value = enc.encode(JSON.stringify({ claimedBy: 'peer-1', claimedAt: 1, expiresAt: 2 }))
    await expect(validateKalthraxiusRecord(validKey, value)).resolves.toBeUndefined()
  })

  it('accepts an aggregator-announcement shape', async () => {
    const value = enc.encode(
      JSON.stringify({ role: 'aggregator', peerId: 'p', stats: { totalJobs: 0 }, announcedAt: 1 }),
    )
    await expect(validateKalthraxiusRecord(validKey, value)).resolves.toBeUndefined()
  })
})

describe('validateKalthraxiusRecord — rejects the exhaustion vectors (GHSA-32mq-hpph-xfvr)', () => {
  it('rejects an oversized value (the core anti-flood bound)', async () => {
    const big = enc.encode(JSON.stringify({ junk: 'x'.repeat(MAX_RECORD_VALUE_BYTES) }))
    expect(big.byteLength).toBeGreaterThan(MAX_RECORD_VALUE_BYTES)
    expect(await rejects(validKey, big)).toBe(true)
  })

  it('rejects an empty value', async () => {
    expect(await rejects(validKey, new Uint8Array(0))).toBe(true)
  })

  it('rejects a non-JSON blob', async () => {
    expect(await rejects(validKey, enc.encode('not json at all'))).toBe(true)
  })

  it('rejects a JSON array (not an object)', async () => {
    expect(await rejects(validKey, enc.encode('[1,2,3]'))).toBe(true)
  })

  it('rejects a JSON primitive', async () => {
    expect(await rejects(validKey, enc.encode('42'))).toBe(true)
  })
})

describe('validateKalthraxiusRecord — rejects malformed keys', () => {
  const goodValue = enc.encode(JSON.stringify({ ok: true }))

  it('rejects a key outside the kalthraxius namespace', async () => {
    expect(await rejects(enc.encode('/other/abc'), goodValue)).toBe(true)
  })

  it('rejects a kalthraxius key without a valid sha256 suffix', async () => {
    expect(await rejects(enc.encode('/kalthraxius/not-a-hash'), goodValue)).toBe(true)
  })

  it('rejects a key with extra path segments', async () => {
    expect(await rejects(enc.encode(`/kalthraxius/${sha256('x')}/extra`), goodValue)).toBe(true)
  })

  it('rejects an uppercase-hex suffix (must be lowercase sha256)', async () => {
    const upper = sha256('x').toUpperCase()
    expect(await rejects(enc.encode(`/kalthraxius/${upper}`), goodValue)).toBe(true)
  })
})
