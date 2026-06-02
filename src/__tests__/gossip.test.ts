import { describe, it, expect } from 'vitest'
import { jobTopic, publishJob, subscribeToJobs } from '../gossip.js'
import { spawnConnectedCluster, stopAll } from './helpers/network.js'
import type { RawJob } from '../types.js'

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    contentHash: 'gossip-test-hash',
    platformId: 'greenhouse',
    url: 'https://boards.greenhouse.io/stripe/jobs/1',
    title: 'Senior Engineer',
    company: 'Stripe',
    location: 'Remote',
    description: 'Build things',
    salary: '$180k',
    postedAt: '2026-05-01',
    scrapedAt: Date.now(),
    ...overrides,
  }
}

function waitForMessage(pubsub: any, platformId: string, timeout = 5_000): Promise<RawJob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeout)
    const unsub = subscribeToJobs(pubsub, platformId, (job) => {
      clearTimeout(timer)
      unsub()
      resolve(job)
    })
  })
}

describe('jobTopic', () => {
  it('returns a consistent topic string', () => {
    expect(jobTopic('greenhouse')).toBe('/kalthraxius/jobs/greenhouse/v1')
    expect(jobTopic('linkedin')).toBe('/kalthraxius/jobs/linkedin/v1')
  })
})

describe('GossipSub job propagation', () => {
  it('job published by A is received by B', async () => {
    const [nodeA, nodeB] = await spawnConnectedCluster(2)
    try {
      const job = makeJob()
      const received = waitForMessage(nodeB.services.pubsub, job.platformId)

      // Extra pause to ensure GossipSub mesh is formed before publishing
      await new Promise(r => setTimeout(r, 600))
      await publishJob(nodeA.services.pubsub, job)

      const msg = await received
      expect(msg.contentHash).toBe(job.contentHash)
      expect(msg.title).toBe(job.title)
    } finally {
      await stopAll([nodeA, nodeB])
    }
  }, 15_000)

  it('job published by A propagates to all 3 subscribers', async () => {
    const [nodeA, nodeB, nodeC] = await spawnConnectedCluster(3)
    try {
      const job = makeJob({ contentHash: 'multi-sub-test' })
      const receivedB = waitForMessage(nodeB.services.pubsub, job.platformId)
      const receivedC = waitForMessage(nodeC.services.pubsub, job.platformId)

      await new Promise(r => setTimeout(r, 600))
      await publishJob(nodeA.services.pubsub, job)

      const [msgB, msgC] = await Promise.all([receivedB, receivedC])
      expect(msgB.contentHash).toBe(job.contentHash)
      expect(msgC.contentHash).toBe(job.contentHash)
    } finally {
      await stopAll([nodeA, nodeB, nodeC])
    }
  }, 15_000)

  it('subscriber on wrong platform does not receive job', async () => {
    const [nodeA, nodeB] = await spawnConnectedCluster(2)
    try {
      const received: RawJob[] = []
      const unsub = subscribeToJobs(nodeB.services.pubsub, 'linkedin', (job) => {
        received.push(job)
      })

      await new Promise(r => setTimeout(r, 600))
      await publishJob(nodeA.services.pubsub, makeJob({ platformId: 'greenhouse' }))
      await new Promise(r => setTimeout(r, 500))

      unsub()
      expect(received).toHaveLength(0)
    } finally {
      await stopAll([nodeA, nodeB])
    }
  }, 15_000)
})
