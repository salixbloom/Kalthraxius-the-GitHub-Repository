/**
 * A plain Bloom filter over content-hash strings, used for the periodic
 * "what jobs do I hold" gossip broadcast (PLAN.md Phase 5). Peers test a hash
 * against a received filter to decide whether to bother requesting it — false
 * positives are acceptable (a wasted check), false negatives are not (the
 * filter must never claim it lacks a hash it actually has).
 *
 * Dependency-free: bits packed into a Uint8Array, k hash functions derived by
 * double-hashing two 32-bit seeds extracted from the (already SHA-256) input.
 */
export class BloomFilter {
  readonly bits: Uint8Array
  readonly numBits: number
  readonly numHashes: number

  private constructor(bits: Uint8Array, numBits: number, numHashes: number) {
    this.bits = bits
    this.numBits = numBits
    this.numHashes = numHashes
  }

  /**
   * Size a filter for `expectedItems` at target false-positive rate `fpRate`.
   * m = -n·ln(p)/ln(2)², k = (m/n)·ln2 — the standard optimal sizing.
   */
  static create(expectedItems: number, fpRate = 0.01): BloomFilter {
    const n = Math.max(1, expectedItems)
    const m = Math.ceil((-n * Math.log(fpRate)) / (Math.LN2 * Math.LN2))
    const numBits = Math.max(8, m)
    const numHashes = Math.max(1, Math.round((numBits / n) * Math.LN2))
    return new BloomFilter(new Uint8Array(Math.ceil(numBits / 8)), numBits, numHashes)
  }

  add(item: string): void {
    const [h1, h2] = seeds(item)
    for (let i = 0; i < this.numHashes; i++) {
      const bit = (h1 + i * h2) % this.numBits
      const idx = bit >>> 3
      this.bits[idx] = this.bits[idx]! | (1 << (bit & 7))
    }
  }

  has(item: string): boolean {
    const [h1, h2] = seeds(item)
    for (let i = 0; i < this.numHashes; i++) {
      const bit = (h1 + i * h2) % this.numBits
      const idx = bit >>> 3
      if ((this.bits[idx]! & (1 << (bit & 7))) === 0) return false
    }
    return true
  }

  /** Serialize for gossip: header (numBits, numHashes) + packed bits. */
  serialize(): Uint8Array {
    const out = new Uint8Array(8 + this.bits.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, this.numBits, true)
    view.setUint32(4, this.numHashes, true)
    out.set(this.bits, 8)
    return out
  }

  static deserialize(data: Uint8Array): BloomFilter {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const numBits = view.getUint32(0, true)
    const numHashes = view.getUint32(4, true)
    return new BloomFilter(data.slice(8), numBits, numHashes)
  }

  static fromHashes(hashes: string[], fpRate = 0.01): BloomFilter {
    const filter = BloomFilter.create(hashes.length, fpRate)
    for (const h of hashes) filter.add(h)
    return filter
  }
}

/**
 * Derive two non-negative 32-bit seeds from a string. Inputs are SHA-256 hex
 * digests, so they're already well-distributed; we fold the hex into two
 * 32-bit accumulators (FNV-style) for the double-hashing scheme. `| 1` on h2
 * keeps the step odd so successive probes don't collapse to one bit.
 */
function seeds(item: string): [number, number] {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < item.length; i++) {
    const c = item.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return [h1 >>> 0, (h2 | 1) >>> 0]
}
