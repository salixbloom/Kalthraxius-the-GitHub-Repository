/**
 * HARD GATE — DHT churn test.
 * Must pass before Phase 4 begins.
 *
 * Production criteria: 10 nodes, 5 min random join/leave, DHT stays functional.
 * Test criteria: 5 nodes, 30s churn — same invariants, shorter clock.
 */
import { describe, it, expect } from 'vitest'
import { claimTarget, getClaim } from '../scrape-claim.js'
import { spawnNode, stopAll } from './helpers/network.js'
import type { KalthraxiusNode } from '../p2p-node.js'

const PLATFORM = 'greenhouse'
const LISTEN_ADDR = '/ip4/127.0.0.1/tcp/0'

async function connectToAll(newcomer: KalthraxiusNode, peers: KalthraxiusNode[]): Promise<void> {
  for (const peer of peers) {
    const addr = peer.getMultiaddrs()[0]
    if (addr) {
      try { await newcomer.dial(addr) } catch { /* ignore — peer might be stopping */ }
    }
  }
}

describe('DHT churn — HARD GATE', () => {
  it('DHT remains functional after 30s of random join/leave', async () => {
    const TOTAL_NODES = 5
    const CHURN_DURATION_MS = 30_000
    const CHURN_INTERVAL_MS = 3_000

    // Start the initial cluster
    let cluster: KalthraxiusNode[] = []
    for (let i = 0; i < TOTAL_NODES; i++) {
      const node = await spawnNode()
      await connectToAll(node, cluster)
      cluster.push(node)
    }

    // Let routing tables stabilise before starting churn
    await new Promise(r => setTimeout(r, 500))

    // Put a record before churn starts — tests replication resilience
    const PRE_CHURN_URL = 'https://example.com/jobs/pre-churn'
    await claimTarget(
      cluster[0].services.dht,
      PLATFORM,
      PRE_CHURN_URL,
      cluster[0].peerId.toString(),
      300_000
    )

    // Churn loop: every CHURN_INTERVAL_MS, kill a random non-first node and replace it
    const churnStart = Date.now()
    let churnRound = 0
    while (Date.now() - churnStart < CHURN_DURATION_MS) {
      await new Promise(r => setTimeout(r, CHURN_INTERVAL_MS))

      // Pick a victim — never kill index 0 so a well-connected node always exists
      const victimIdx = 1 + Math.floor(Math.random() * (cluster.length - 1))
      const victim = cluster[victimIdx]
      cluster.splice(victimIdx, 1)
      // Fire-and-forget; don't block the churn loop. Swallow shutdown races
      // (libp2p may abort in-flight queries while stopping).
      Promise.resolve(victim.stop()).catch(() => {})

      // Spawn a replacement and connect it to current surviving nodes
      const replacement = await spawnNode()
      await connectToAll(replacement, cluster)
      cluster.push(replacement)

      churnRound++
    }

    // After churn, verify:
    // 1. Freshly put record can be retrieved (DHT puts still work)
    const POST_CHURN_URL = 'https://example.com/jobs/post-churn'
    await claimTarget(
      cluster[0].services.dht,
      PLATFORM,
      POST_CHURN_URL,
      cluster[0].peerId.toString(),
      300_000
    )
    const postChurnClaim = await getClaim(cluster[1].services.dht, PLATFORM, POST_CHURN_URL)
    expect(postChurnClaim).not.toBeNull()
    expect(postChurnClaim?.claimedBy).toBe(cluster[0].peerId.toString())

    // 2. At least 1 surviving node can still find the pre-churn record
    //    (tests replication — may fail if all replicas were on churned nodes, acceptable)
    let preChurnFound = false
    for (const node of cluster) {
      const claim = await getClaim(node.services.dht, PLATFORM, PRE_CHURN_URL)
      if (claim !== null) { preChurnFound = true; break }
    }
    expect(preChurnFound).toBe(true)

    expect(churnRound).toBeGreaterThanOrEqual(5)

    await stopAll(cluster)
  }, 60_000)
})
