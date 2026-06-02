import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { ping } from '@libp2p/ping'
import { identify } from '@libp2p/identify'
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { bootstrap } from '@libp2p/bootstrap'
import type { Libp2p, PubSub } from '@libp2p/interface'
import { validateKalthraxiusRecord } from './dht-validator.js'
import type { Ed25519Identity } from './identity.js'
import type { Ping } from '@libp2p/ping'
import type { KadDHT } from '@libp2p/kad-dht'
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub'

export interface NodeOptions {
  privateKey: Ed25519Identity
  listenAddresses: string[]
  bootstrapAddresses?: string[]
  /**
   * When true, keep private/loopback addresses in the DHT routing table.
   * Required for local single-host clusters (tests, dev). In production,
   * leave false so only publicly-dialable peers enter the routing table.
   */
  allowPrivateAddresses?: boolean
}

/**
 * DHT validator: throws if a record is invalid, resolves otherwise. Hardened to
 * enforce a value size cap + key/value shape (see dht-validator.ts) so a peer
 * can't flood our (memory) datastore — mitigates GHSA-32mq-hpph-xfvr, which has
 * no fix on our v2-pinned kad-dht line. Keyed by the first key path segment
 * (`/kalthraxius/...`).
 */
const acceptRecord = validateKalthraxiusRecord

/**
 * DHT selector: picks the best record among several for the same key.
 * Scrape-claims are last-writer-wins with TTL semantics enforced by the
 * application, so any returned record is acceptable — return the first.
 */
const selectFirst = (_key: Uint8Array, _records: Uint8Array[]): number => 0

export type KalthraxiusNode = Libp2p<{
  ping: Ping
  dht: KadDHT
  pubsub: PubSub<GossipsubEvents>
}>

export async function createNode(options: NodeOptions): Promise<KalthraxiusNode> {
  const peerDiscovery = options.bootstrapAddresses?.length
    ? [bootstrap({ list: options.bootstrapAddresses })]
    : []

  return createLibp2p({
    privateKey: options.privateKey,
    addresses: {
      listen: options.listenAddresses,
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      ping: ping(),
      identify: identify(),
      dht: kadDHT({
        protocol: '/kalthraxius/kad/1.0.0',
        clientMode: false,
        // Don't block queries while the routing table is still cold.
        allowQueryWithZeroPeers: true,
        // In local/test clusters all addresses are loopback; keep them so the
        // routing table populates. Production nodes have public addrs and use
        // the default filtering mapper.
        peerInfoMapper: options.allowPrivateAddresses ? passthroughMapper : undefined,
        validators: { kalthraxius: acceptRecord },
        selectors: { kalthraxius: selectFirst },
      }),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        D: 2,
        Dlo: 1,
        Dhi: 4,
        heartbeatInterval: 500,
      }),
    },
  }) as Promise<KalthraxiusNode>
}
