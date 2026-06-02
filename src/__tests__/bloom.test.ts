import { describe, it, expect } from 'vitest'
import { BloomFilter } from '../aggregator/bloom.js'
import { encodeBloomBroadcast, decodeBloomBroadcast } from '../aggregator/bloom-gossip.js'
import { sha256 } from '../hasher.js'

function hashes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => sha256(`job-${i}`))
}

describe('BloomFilter — membership', () => {
  it('never reports a false negative for added items', () => {
    const items = hashes(500)
    const f = BloomFilter.fromHashes(items)
    for (const h of items) expect(f.has(h)).toBe(true)
  })

  it('keeps the false-positive rate near the target', () => {
    const present = new Set(hashes(1000))
    const f = BloomFilter.fromHashes([...present], 0.01)
    // Probe with hashes that were NOT added.
    let falsePositives = 0
    const probes = 5000
    for (let i = 0; i < probes; i++) {
      const h = sha256(`absent-${i}`)
      if (present.has(h)) continue
      if (f.has(h)) falsePositives++
    }
    const rate = falsePositives / probes
    // Allow generous headroom over the 1% target.
    expect(rate).toBeLessThan(0.05)
  })

  it('an empty filter reports no membership', () => {
    const f = BloomFilter.fromHashes([])
    expect(f.has(sha256('anything'))).toBe(false)
  })
})

describe('BloomFilter — serialization', () => {
  it('round-trips through serialize/deserialize preserving membership', () => {
    const items = hashes(200)
    const f = BloomFilter.fromHashes(items)
    const restored = BloomFilter.deserialize(f.serialize())
    expect(restored.numBits).toBe(f.numBits)
    expect(restored.numHashes).toBe(f.numHashes)
    for (const h of items) expect(restored.has(h)).toBe(true)
  })
})

describe('bloom-gossip wire format', () => {
  it('round-trips peerId + filter', () => {
    const items = hashes(50)
    const f = BloomFilter.fromHashes(items)
    const wire = encodeBloomBroadcast('12D3KooWPeerId', f)
    const { peerId, filter } = decodeBloomBroadcast(wire)
    expect(peerId).toBe('12D3KooWPeerId')
    for (const h of items) expect(filter.has(h)).toBe(true)
  })
})
