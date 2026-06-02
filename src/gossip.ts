import type { PubSub, Message } from '@libp2p/interface'
import type { RawJob } from './types.js'

export function jobTopic(platformId: string): string {
  return `/kalthraxius/jobs/${platformId}/v1`
}

export async function publishJob(pubsub: PubSub, job: RawJob): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(job))
  await pubsub.publish(jobTopic(job.platformId), data)
}

export function subscribeToJobs(
  pubsub: PubSub,
  platformId: string,
  handler: (job: RawJob) => void
): () => void {
  const topic = jobTopic(platformId)
  pubsub.subscribe(topic)

  const listener = (event: CustomEvent<Message>) => {
    if (event.detail.topic !== topic) return
    try {
      const job = JSON.parse(new TextDecoder().decode(event.detail.data)) as RawJob
      handler(job)
    } catch {
      // malformed message — drop silently
    }
  }

  pubsub.addEventListener('message', listener as EventListener)

  return () => {
    pubsub.removeEventListener('message', listener as EventListener)
    pubsub.unsubscribe(topic)
  }
}
