import { existsSync } from 'node:fs'
import { generateIdentity, loadIdentity, saveIdentity } from '../identity.js'
import { createNode } from '../p2p-node.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { Ed25519Identity } from '../identity.js'

/**
 * Shared bootstrap for the role entrypoints (aggregator / scraper /
 * aggregator-scraper). Reads config from the environment, persists a stable
 * node identity, creates + starts a libp2p node, and registers graceful
 * shutdown. Each entrypoint adds its role on top.
 *
 * Environment:
 *   KAL_LISTEN          libp2p listen multiaddr (default /ip4/0.0.0.0/tcp/0)
 *   KAL_ANNOUNCE        comma-separated multiaddrs to advertise to peers.
 *                       Required behind NAT/Docker: set to the public DNS/IP
 *                       addr so other nodes can dial back (e.g.
 *                       /dns4/jobs.example.com/tcp/4001/p2p/<peerId>)
 *   KAL_BOOTSTRAP       comma-separated bootstrap multiaddrs (peers to dial)
 *   KAL_IDENTITY_FILE   path to persist the Ed25519 key (default ./node.key)
 *   KAL_ALLOW_PRIVATE   "1"/"true" to keep loopback addrs in the DHT routing
 *                       table (local/dev clusters). Off in production.
 */

export interface BaseConfig {
  listen: string
  announce: string[]
  bootstrap: string[]
  identityFile: string
  allowPrivateAddresses: boolean
}

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export function envBool(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v === 'true' || v === 'yes'
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function splitMultiaddrs(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export function baseConfig(): BaseConfig {
  return {
    listen: env('KAL_LISTEN', '/ip4/0.0.0.0/tcp/0')!,
    announce: splitMultiaddrs(env('KAL_ANNOUNCE', '')),
    bootstrap: splitMultiaddrs(env('KAL_BOOTSTRAP', '')),
    identityFile: env('KAL_IDENTITY_FILE', 'node.key')!,
    allowPrivateAddresses: envBool('KAL_ALLOW_PRIVATE'),
  }
}

/** Load the persisted identity, or generate + save a new one on first run. */
export async function loadOrCreateIdentity(filePath: string): Promise<Ed25519Identity> {
  if (existsSync(filePath)) {
    return loadIdentity(filePath)
  }
  const identity = await generateIdentity()
  saveIdentity(identity, filePath)
  console.log(`[identity] generated new key → ${filePath}`)
  return identity
}

/** Create + start a libp2p node from base config, dialing any bootstrap peers. */
export async function startNode(cfg: BaseConfig): Promise<KalthraxiusNode> {
  const privateKey = await loadOrCreateIdentity(cfg.identityFile)
  const node = await createNode({
    privateKey,
    listenAddresses: [cfg.listen],
    announceAddresses: cfg.announce.length ? cfg.announce : undefined,
    bootstrapAddresses: cfg.bootstrap.length ? cfg.bootstrap : undefined,
    allowPrivateAddresses: cfg.allowPrivateAddresses,
  })
  await node.start()

  console.log(`[node] peerId ${node.peerId.toString()}`)
  for (const addr of node.getMultiaddrs()) {
    console.log(`[node] listening ${addr.toString()}`)
  }

  // Best-effort dial of bootstrap peers so the DHT/gossip meshes form promptly.
  for (const addr of cfg.bootstrap) {
    try {
      const { multiaddr } = await import('@multiformats/multiaddr')
      await node.dial(multiaddr(addr))
      console.log(`[node] dialed bootstrap ${addr}`)
    } catch (err) {
      console.warn(`[node] could not dial ${addr}: ${errMsg(err)}`)
    }
  }

  return node
}

/**
 * Register SIGINT/SIGTERM handlers that run `shutdown` once, then exit. Returns
 * a promise that never resolves (keeps the process alive until a signal). Use
 * `await runUntilSignal(...)` as the tail of an entrypoint.
 */
export function runUntilSignal(shutdown: () => Promise<void>): Promise<never> {
  let shuttingDown = false
  const handle = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[shutdown] ${signal} received, stopping…`)
    shutdown()
      .then(() => {
        console.log('[shutdown] done')
        process.exit(0)
      })
      .catch(err => {
        console.error(`[shutdown] error: ${errMsg(err)}`)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => handle('SIGINT'))
  process.on('SIGTERM', () => handle('SIGTERM'))
  return new Promise<never>(() => {})
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function fail(message: string): never {
  console.error(`[error] ${message}`)
  process.exit(1)
}
