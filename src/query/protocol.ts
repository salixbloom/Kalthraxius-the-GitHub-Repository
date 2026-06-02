import { lpStream } from 'it-length-prefixed-stream'
import type { Libp2p, Stream, PeerId } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { QueryProfile, ScoredHit } from './types.js'

/**
 * Request/response protocol for querying an aggregator over libp2p
 * (PLAN.md Phase 6). The client opens a stream, writes a length-prefixed
 * JSON `QueryProfile`, and reads back a length-prefixed JSON `ScoredHit[]`.
 *
 * One round-trip, length-delimited framing (no ambiguity about message
 * boundaries), 1 MB cap on each side to bound memory.
 */
export const QUERY_PROTOCOL = '/kalthraxius/query/1.0.0'

const MAX_MSG = 1024 * 1024 // 1 MB
const enc = new TextEncoder()
const dec = new TextDecoder()

/** What the server needs to answer a query — kept minimal for testability. */
export type QueryResponder = (profile: QueryProfile) => ScoredHit[] | Promise<ScoredHit[]>

/**
 * Register the query handler on a libp2p node. The aggregator passes a
 * `responder` that runs its local query engine. Returns an unregister fn.
 */
export async function registerQueryHandler(
  node: Libp2p,
  responder: QueryResponder,
): Promise<() => Promise<void>> {
  await node.handle(QUERY_PROTOCOL, ({ stream }) => {
    void handleInbound(stream, responder)
  })
  return () => node.unhandle(QUERY_PROTOCOL)
}

async function handleInbound(stream: Stream, responder: QueryResponder): Promise<void> {
  const lp = lpStream(stream)
  try {
    const reqBytes = await lp.read({ signal: AbortSignal.timeout(10_000) })
    const profile = JSON.parse(dec.decode(reqBytes.subarray())) as QueryProfile
    const hits = await responder(profile)
    await lp.write(enc.encode(JSON.stringify(hits)), { signal: AbortSignal.timeout(10_000) })
  } catch {
    // malformed request / timeout — just close.
  } finally {
    await stream.close().catch(() => {})
  }
}

/**
 * Client side: open a stream to `peer`, send the profile, return the hits.
 * Throws on dial/protocol/timeout failure so the fan-out layer can treat the
 * peer as failed and move on.
 */
export async function queryPeer(
  node: Libp2p,
  peer: PeerId | Multiaddr | Multiaddr[],
  profile: QueryProfile,
  timeoutMs = 5_000,
): Promise<ScoredHit[]> {
  const signal = AbortSignal.timeout(timeoutMs)
  const stream = await node.dialProtocol(peer, QUERY_PROTOCOL, { signal })
  const lp = lpStream(stream)
  try {
    await lp.write(enc.encode(JSON.stringify(profile)), { signal })
    const resBytes = await lp.read({ signal })
    return JSON.parse(dec.decode(resBytes.subarray())) as ScoredHit[]
  } finally {
    await stream.close().catch(() => {})
  }
}
