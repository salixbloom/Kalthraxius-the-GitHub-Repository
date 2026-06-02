import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 as mhsha256 } from 'multiformats/hashes/sha2'
import { EventTypes } from '@libp2p/kad-dht'
import type { KadDHT } from '@libp2p/kad-dht'
import type { PeerId, PeerInfo } from '@libp2p/interface'

/**
 * Aggregator discovery via DHT content routing (PLAN.md Phase 6: "client
 * aggregator discovery via DHT role:aggregator lookup").
 *
 * All aggregators `provide` one well-known rendezvous CID; a client
 * `findProviders` on that CID to ENUMERATE the live aggregator set (you don't
 * need to know any peer id in advance). This is the discovery primitive the
 * fan-out and failover logic build on.
 */

// Stable rendezvous key — every aggregator provides this exact CID.
const RENDEZVOUS_LABEL = 'kalthraxius:role:aggregator:v1'

let cachedCid: CID | null = null

export async function aggregatorRendezvousCid(): Promise<CID> {
  if (cachedCid) return cachedCid
  const bytes = new TextEncoder().encode(RENDEZVOUS_LABEL)
  const digest = await mhsha256.digest(bytes)
  cachedCid = CID.createV1(raw.code, digest)
  return cachedCid
}

/** Announce this node as an aggregator on the rendezvous CID. */
export async function provideAggregator(dht: KadDHT): Promise<void> {
  const cid = await aggregatorRendezvousCid()
  for await (const _ of dht.provide(cid)) {
    /* drain provide events */
  }
}

/**
 * Enumerate known aggregator peers. Returns up to `max` provider PeerInfos,
 * excluding `self` if given. Best-effort: routing failures yield whatever was
 * found before the error.
 */
export async function findAggregators(
  dht: KadDHT,
  opts: { max?: number; self?: PeerId } = {},
): Promise<PeerInfo[]> {
  const max = opts.max ?? 20
  const cid = await aggregatorRendezvousCid()
  const found: PeerInfo[] = []
  const seen = new Set<string>()

  try {
    for await (const event of dht.findProviders(cid)) {
      if (event.type !== EventTypes.PROVIDER) continue
      for (const provider of event.providers) {
        const id = provider.id.toString()
        if (opts.self && provider.id.equals(opts.self)) continue
        if (seen.has(id)) continue
        seen.add(id)
        found.push(provider)
        if (found.length >= max) return found
      }
    }
  } catch {
    // routing failure — return what we have
  }
  return found
}
