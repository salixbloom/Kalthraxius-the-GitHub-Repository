import { EventTypes } from '@libp2p/kad-dht'
import { sha256 } from './hasher.js'
import type { KadDHT } from '@libp2p/kad-dht'

export interface ClaimRecord {
  claimedBy: string
  claimedAt: number
  expiresAt: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function claimKey(platformId: string, url: string): Uint8Array {
  return enc.encode(`/kalthraxius/${sha256(platformId + '/' + url)}`)
}

export async function claimTarget(
  dht: KadDHT,
  platformId: string,
  url: string,
  claimedBy: string,
  ttlMs: number
): Promise<void> {
  const key = claimKey(platformId, url)
  const now = Date.now()
  const record: ClaimRecord = { claimedBy, claimedAt: now, expiresAt: now + ttlMs }
  const value = enc.encode(JSON.stringify(record))
  for await (const _ of dht.put(key, value)) { /* drain put events */ }
}

export async function getClaim(
  dht: KadDHT,
  platformId: string,
  url: string
): Promise<ClaimRecord | null> {
  const key = claimKey(platformId, url)
  try {
    for await (const event of dht.get(key)) {
      if (event.type === EventTypes.VALUE) {
        const record = JSON.parse(dec.decode(event.value)) as ClaimRecord
        if (record.expiresAt < Date.now()) return null
        return record
      }
    }
  } catch {
    // no record found or routing failure
  }
  return null
}

export async function hasActiveClaim(
  dht: KadDHT,
  platformId: string,
  url: string
): Promise<boolean> {
  return (await getClaim(dht, platformId, url)) !== null
}
