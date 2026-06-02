import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

/**
 * Hardened DHT record validator (mitigates GHSA-32mq-hpph-xfvr / CVE-2026-45783).
 *
 * The advisory: @libp2p/kad-dht < 16.2.6 stores PUT_VALUE records whose keys
 * have fewer than three slash-parts WITHOUT validation, and the RPC handler
 * lets a peer stream unlimited PUTs — so an unauthenticated peer can exhaust a
 * server node's datastore (RAM for us, since we use the default MemoryDatastore).
 * The fix only exists on the v3 interface line (16.2.6+), which we can't adopt
 * while gossipsub is v2-only (see memory: libp2p-v2-stack-pin). So we close the
 * practical attack surface IN OUR OWN validator instead.
 *
 * The previous validator was a no-op (`async () => {}`) — it accepted and stored
 * every record under `/kalthraxius/...`, which was the bigger hole than the
 * library's malformed-key bug. This validator instead enforces:
 *   1. a strict per-record VALUE SIZE CAP (bounds amplification per PUT), and
 *   2. that the key matches our exact namespaced shape `/kalthraxius/<sha256hex>`, and
 *   3. that the value is well-formed JSON of bounded shape.
 * Anything else throws, so kad-dht discards it and never writes it to the store.
 *
 * This doesn't patch the library's internal `<3 parts` early-return (a record
 * with a malformed key never reaches our validator at all), but those records
 * carry no namespace we serve and our protocol is a private one
 * (`/kalthraxius/kad/1.0.0`), not the public IPFS DHT — so the realistic flood
 * vector (spamming our namespace) is the one we now reject.
 */

/**
 * Max bytes for a single DHT record value. Our real records (scrape-claims,
 * aggregator announcements) are a few hundred bytes; 8 KiB is generous
 * headroom while still bounding a flood. A record over this is rejected.
 */
export const MAX_RECORD_VALUE_BYTES = 8 * 1024

/** Our keys are exactly `/kalthraxius/<64 lowercase hex>` (a sha256 digest). */
const KEY_RE = /^\/kalthraxius\/[0-9a-f]{64}$/

export class InvalidDhtRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDhtRecordError'
  }
}

/**
 * Validator for the `kalthraxius` namespace. Throws (→ record discarded) unless
 * the key shape, value size, and value JSON shape all check out. Plain async
 * function as @libp2p/kad-dht@15 expects (key, value) => Promise<void>.
 */
export const validateKalthraxiusRecord = async (
  key: Uint8Array,
  value: Uint8Array,
): Promise<void> => {
  // 1. Value size cap — the core anti-exhaustion bound.
  if (value.byteLength > MAX_RECORD_VALUE_BYTES) {
    throw new InvalidDhtRecordError(
      `record value ${value.byteLength}B exceeds ${MAX_RECORD_VALUE_BYTES}B cap`,
    )
  }
  if (value.byteLength === 0) {
    throw new InvalidDhtRecordError('empty record value')
  }

  // 2. Key shape — must be exactly our namespaced sha256 form.
  const keyStr = uint8ArrayToString(key)
  if (!KEY_RE.test(keyStr)) {
    throw new InvalidDhtRecordError(`key does not match /kalthraxius/<sha256>: ${keyStr}`)
  }

  // 3. Value must be a JSON object (claim or announcement). We don't enforce the
  //    full schema here — content integrity is a separate, app-level concern
  //    (SHA-256 hashing) — but rejecting non-JSON / non-object blobs stops the
  //    store being filled with arbitrary payloads.
  let parsed: unknown
  try {
    parsed = JSON.parse(uint8ArrayToString(value))
  } catch {
    throw new InvalidDhtRecordError('record value is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidDhtRecordError('record value is not a JSON object')
  }
}
