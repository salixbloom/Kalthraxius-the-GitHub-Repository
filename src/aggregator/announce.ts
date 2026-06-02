import { EventTypes } from '@libp2p/kad-dht'
import { sha256 } from '../hasher.js'
import type { KadDHT } from '@libp2p/kad-dht'
import type { AggregatorStats } from './store.js'

/**
 * DHT announcement of an aggregator's presence and self-reported coverage
 * stats (PLAN.md Phase 5; the basis for cross-aggregator consistency checks in
 * Phase 7). A client looks these up to discover aggregators and weigh them.
 *
 * The stats are SELF-REPORTED and therefore untrusted — Phase 7 verifies them
 * against actual behaviour (content-hash integrity, staleness probes). Here we
 * only guarantee that what's announced matches the node's own DB at publish
 * time (verified by `stats()` round-tripping through the store).
 */
export interface AggregatorAnnouncement {
  role: 'aggregator'
  peerId: string
  stats: AggregatorStats
  announcedAt: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** DHT key for an aggregator's announcement, namespaced under `kalthraxius`. */
export function announcementKey(peerId: string): Uint8Array {
  return enc.encode(`/kalthraxius/${sha256('role:aggregator:' + peerId)}`)
}

export async function announceAggregator(
  dht: KadDHT,
  peerId: string,
  stats: AggregatorStats,
): Promise<void> {
  const announcement: AggregatorAnnouncement = {
    role: 'aggregator',
    peerId,
    stats,
    announcedAt: Date.now(),
  }
  const key = announcementKey(peerId)
  const value = enc.encode(JSON.stringify(announcement))
  for await (const _ of dht.put(key, value)) {
    /* drain put events */
  }
}

export async function getAggregatorAnnouncement(
  dht: KadDHT,
  peerId: string,
): Promise<AggregatorAnnouncement | null> {
  const key = announcementKey(peerId)
  try {
    for await (const event of dht.get(key)) {
      if (event.type === EventTypes.VALUE) {
        return JSON.parse(dec.decode(event.value)) as AggregatorAnnouncement
      }
    }
  } catch {
    // no record / routing failure
  }
  return null
}
