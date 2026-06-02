import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = join(__dirname, '..', 'data', 'platforms.json')

interface PlatformRegistryFile {
  version: number
  platforms: string[]
}

/**
 * The curated set of platform ids the network knows about. The aggregator
 * subscribes to one GossipSub topic per platform (see jobTopic), so this list
 * defines its subscription fan-out. Adding a platform = editing
 * data/platforms.json — deterministic, fits the curated-aggregator model
 * (PLAN.md "Model A").
 */
export function loadPlatforms(): string[] {
  const file = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as PlatformRegistryFile
  return file.platforms
}
