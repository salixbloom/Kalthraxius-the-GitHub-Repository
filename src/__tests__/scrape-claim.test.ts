import { describe, it, expect } from 'vitest'
import { claimKey, claimTarget, getClaim, hasActiveClaim } from '../scrape-claim.js'
import { spawnConnectedCluster, stopAll } from './helpers/network.js'

const PLATFORM = 'greenhouse'
const URL = 'https://boards.greenhouse.io/stripe/jobs/123'

describe('claimKey', () => {
  it('is deterministic for the same inputs', () => {
    const a = claimKey(PLATFORM, URL)
    const b = claimKey(PLATFORM, URL)
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
  })

  it('differs for different URLs', () => {
    const a = claimKey(PLATFORM, URL)
    const b = claimKey(PLATFORM, URL + '/other')
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'))
  })
})

describe('scrape-claim DHT operations', () => {
  it('node A claims; node B finds the active claim', async () => {
    const [nodeA, nodeB] = await spawnConnectedCluster(2)
    try {
      await claimTarget(nodeA.services.dht, PLATFORM, URL, nodeA.peerId.toString(), 30_000)
      const claim = await getClaim(nodeB.services.dht, PLATFORM, URL)
      expect(claim).not.toBeNull()
      expect(claim?.claimedBy).toBe(nodeA.peerId.toString())
    } finally {
      await stopAll([nodeA, nodeB])
    }
  }, 15_000)

  it('3-node harness: A claims, B and C both see it', async () => {
    const [nodeA, nodeB, nodeC] = await spawnConnectedCluster(3)
    try {
      await claimTarget(nodeA.services.dht, PLATFORM, URL, nodeA.peerId.toString(), 30_000)
      const [claimB, claimC] = await Promise.all([
        getClaim(nodeB.services.dht, PLATFORM, URL),
        getClaim(nodeC.services.dht, PLATFORM, URL),
      ])
      expect(claimB?.claimedBy).toBe(nodeA.peerId.toString())
      expect(claimC?.claimedBy).toBe(nodeA.peerId.toString())
    } finally {
      await stopAll([nodeA, nodeB, nodeC])
    }
  }, 15_000)

  it('claim expires after TTL — hasActiveClaim returns false', async () => {
    const [nodeA, nodeB] = await spawnConnectedCluster(2)
    const ttlMs = 100
    try {
      await claimTarget(nodeA.services.dht, PLATFORM, URL + '/ttl', nodeA.peerId.toString(), ttlMs)

      const beforeExpiry = await hasActiveClaim(nodeB.services.dht, PLATFORM, URL + '/ttl')
      expect(beforeExpiry).toBe(true)

      await new Promise(r => setTimeout(r, ttlMs + 50))

      const afterExpiry = await hasActiveClaim(nodeB.services.dht, PLATFORM, URL + '/ttl')
      expect(afterExpiry).toBe(false)
    } finally {
      await stopAll([nodeA, nodeB])
    }
  }, 15_000)

  it('B claims after A\'s TTL expires (simulates A dying mid-claim)', async () => {
    const [nodeA, nodeB] = await spawnConnectedCluster(2)
    const ttlMs = 100
    try {
      await claimTarget(nodeA.services.dht, PLATFORM, URL + '/handoff', nodeA.peerId.toString(), ttlMs)

      await new Promise(r => setTimeout(r, ttlMs + 50))

      // B takes over after TTL
      await claimTarget(nodeB.services.dht, PLATFORM, URL + '/handoff', nodeB.peerId.toString(), 30_000)
      const claim = await getClaim(nodeA.services.dht, PLATFORM, URL + '/handoff')
      expect(claim?.claimedBy).toBe(nodeB.peerId.toString())
    } finally {
      await stopAll([nodeA, nodeB])
    }
  }, 15_000)
})
