import type { PubSub, Message } from '@libp2p/interface'
import { BloomFilter } from './bloom.js'

/**
 * Periodic bloom-filter gossip: an aggregator broadcasts a bloom filter of its
 * content-hash set so peers can cheaply test "do you have job X?" without
 * exchanging full hash lists (PLAN.md Phase 5). One global topic — every
 * aggregator both publishes to and subscribes on it.
 *
 * The wire format is `[peerId-length:u16][peerId utf8][serialized bloom]`, so a
 * receiver knows which aggregator a filter came from.
 */
export const BLOOM_TOPIC = '/kalthraxius/aggregator/bloom/v1'

export interface BloomBroadcast {
  peerId: string
  filter: BloomFilter
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeBloomBroadcast(peerId: string, filter: BloomFilter): Uint8Array {
  const idBytes = enc.encode(peerId)
  const bloomBytes = filter.serialize()
  const out = new Uint8Array(2 + idBytes.length + bloomBytes.length)
  new DataView(out.buffer).setUint16(0, idBytes.length, true)
  out.set(idBytes, 2)
  out.set(bloomBytes, 2 + idBytes.length)
  return out
}

export function decodeBloomBroadcast(data: Uint8Array): BloomBroadcast {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const idLen = view.getUint16(0, true)
  const peerId = dec.decode(data.subarray(2, 2 + idLen))
  const filter = BloomFilter.deserialize(data.subarray(2 + idLen))
  return { peerId, filter }
}

export async function publishBloom(
  pubsub: PubSub,
  peerId: string,
  filter: BloomFilter,
): Promise<void> {
  await pubsub.publish(BLOOM_TOPIC, encodeBloomBroadcast(peerId, filter))
}

export function subscribeToBloom(
  pubsub: PubSub,
  handler: (broadcast: BloomBroadcast) => void,
): () => void {
  pubsub.subscribe(BLOOM_TOPIC)
  const listener = (event: CustomEvent<Message>) => {
    if (event.detail.topic !== BLOOM_TOPIC) return
    try {
      handler(decodeBloomBroadcast(event.detail.data))
    } catch {
      // malformed — drop
    }
  }
  pubsub.addEventListener('message', listener as EventListener)
  return () => {
    pubsub.removeEventListener('message', listener as EventListener)
    pubsub.unsubscribe(BLOOM_TOPIC)
  }
}
