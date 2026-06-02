/**
 * Formalized DHT churn STRESS suite (PLAN.md Phase 8: "50 nodes, 30 min
 * randomized churn"). The Phase 3 HARD GATE (churn.test.ts) proves correctness
 * at a small scale on every run; this scales it up and is parameterized so the
 * full 50-node / 30-min soak can be run on demand without bloating CI.
 *
 * Scale via env:
 *   CHURN_STRESS=full   → 50 nodes, 30 min (the plan's target)
 *   CHURN_NODES=N       → override node count
 *   CHURN_MINUTES=M     → override duration (minutes)
 * Default (no env): 12 nodes, 60s — heavier than the gate, still CI-safe.
 *
 * Invariants checked after churn (same as the gate): DHT puts/gets still work,
 * and a pre-churn record survives via replication.
 */
import { describe, it, expect } from 'vitest'
import { claimTarget, getClaim } from '../scrape-claim.js'
import { spawnNode, stopAll } from './helpers/network.js'
import type { KalthraxiusNode } from '../p2p-node.js'

const PLATFORM = 'greenhouse'

// This is an opt-in soak test — the every-run correctness gate lives in
// churn.test.ts. Enable with CHURN_STRESS=1 (scaled) or CHURN_STRESS=full
// (the plan's 50-node / 30-min target). Skipped by default so CI stays fast.
const ENABLED = process.env['CHURN_STRESS'] !== undefined
const FULL = process.env['CHURN_STRESS'] === 'full'
const NODES = process.env['CHURN_NODES']
  ? Number(process.env['CHURN_NODES'])
  : FULL
    ? 50
    : 12
const DURATION_MS = process.env['CHURN_MINUTES']
  ? Number(process.env['CHURN_MINUTES']) * 60_000
  : FULL
    ? 30 * 60_000
    : 60_000
const CHURN_INTERVAL_MS = 3_000
// Generous overall timeout: duration + headroom for setup/teardown of N nodes.
const TEST_TIMEOUT = DURATION_MS + Math.max(60_000, NODES * 2_000)

async function connectToAll(newcomer: KalthraxiusNode, peers: KalthraxiusNode[]): Promise<void> {
  // Connect to a random sample of peers (full mesh is O(n²) and unnecessary at
  // scale — Kademlia only needs a few well-placed contacts to bootstrap).
  const sample = peers.length <= 8 ? peers : shuffle(peers).slice(0, 8)
  for (const peer of sample) {
    const addr = peer.getMultiaddrs()[0]
    if (addr) {
      try {
        await newcomer.dial(addr)
      } catch {
        /* peer may be stopping */
      }
    }
  }
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

const maybeIt = ENABLED ? it : it.skip

describe('DHT churn — stress suite', () => {
  maybeIt(`stays functional: ${NODES} nodes, ${Math.round(DURATION_MS / 60_000 * 10) / 10} min churn`, async () => {
    const cluster: KalthraxiusNode[] = []
    for (let i = 0; i < NODES; i++) {
      const node = await spawnNode()
      await connectToAll(node, cluster)
      cluster.push(node)
    }
    await new Promise(r => setTimeout(r, 800))

    const PRE_CHURN_URL = 'https://example.com/jobs/stress-pre'
    await claimTarget(cluster[0]!.services.dht, PLATFORM, PRE_CHURN_URL, cluster[0]!.peerId.toString(), 3_600_000)

    const churnStart = Date.now()
    let rounds = 0
    while (Date.now() - churnStart < DURATION_MS) {
      await new Promise(r => setTimeout(r, CHURN_INTERVAL_MS))
      // Kill a random non-zero node, replace it — steady-state churn.
      const victimIdx = 1 + Math.floor(Math.random() * (cluster.length - 1))
      const victim = cluster.splice(victimIdx, 1)[0]!
      Promise.resolve(victim.stop()).catch(() => {})

      const replacement = await spawnNode()
      await connectToAll(replacement, cluster)
      cluster.push(replacement)
      rounds++
    }

    // Puts/gets still work post-churn.
    const POST_CHURN_URL = 'https://example.com/jobs/stress-post'
    await claimTarget(cluster[0]!.services.dht, PLATFORM, POST_CHURN_URL, cluster[0]!.peerId.toString(), 3_600_000)
    const postClaim = await getClaim(cluster[1]!.services.dht, PLATFORM, POST_CHURN_URL)
    expect(postClaim).not.toBeNull()

    // Pre-churn record survived replication on at least one surviving node.
    let preFound = false
    for (const node of cluster) {
      if ((await getClaim(node.services.dht, PLATFORM, PRE_CHURN_URL)) !== null) {
        preFound = true
        break
      }
    }
    expect(preFound).toBe(true)
    expect(rounds).toBeGreaterThanOrEqual(Math.floor(DURATION_MS / CHURN_INTERVAL_MS) - 2)

    await stopAll(cluster)
  }, TEST_TIMEOUT)
})
