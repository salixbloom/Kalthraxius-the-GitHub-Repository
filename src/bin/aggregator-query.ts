/**
 * Aggregator + local query-server entrypoint.
 *
 * Identical to aggregator.ts but also starts a lightweight HTTP server that
 * exposes the local SQLite store and search index directly — no P2P fan-out.
 *
 * Run: node --experimental-strip-types src/bin/aggregator-query.ts
 *
 * Environment (plus the base vars in common.ts and aggregator vars):
 *   KAL_QUERY_PORT      HTTP listen port (default 3000)
 *   KAL_QUERY_HOST      HTTP bind host   (default 127.0.0.1)
 *
 * HTTP API
 * --------
 *   GET  /stats                   — AggregatorStats JSON
 *   GET  /jobs?limit=N            — all jobs, newest first (default limit 100)
 *   GET  /jobs/:hash              — single job by content hash
 *   POST /search                  — { text, platformId?, limit? } → SearchHit[]
 *                                   with the full IndexedJob attached to each hit
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { baseConfig, env, envInt, startNode, runUntilSignal } from './common.js'
import { AggregatorNode } from '../aggregator/node.js'
import { SqliteAggregatorStore } from '../aggregator/store-sqlite.js'
import { SqliteSearchIndex } from '../aggregator/search-sqlite.js'
import { log, flushLogs } from '../logger.js'
import type { SearchQuery } from '../aggregator/search.js'

async function readBody(req: IncomingMessage, cap = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json' })
  res.end(payload)
}

async function main(): Promise<void> {
  const cfg = baseConfig()
  const storePath = env('KAL_STORE_DB', 'aggregator-store.db')!
  const searchPath = env('KAL_SEARCH_DB', 'aggregator-search.db')!
  const platforms = (env('KAL_PLATFORMS', '') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const announceIntervalMs = envInt('KAL_ANNOUNCE_MS', 30_000)
  const queryPort = envInt('KAL_QUERY_PORT', 3000)
  const queryHost = env('KAL_QUERY_HOST', '127.0.0.1')!

  const node = await startNode(cfg)
  const store = new SqliteAggregatorStore(storePath)
  const search = new SqliteSearchIndex(searchPath)

  const aggregator = new AggregatorNode({
    node,
    store,
    search,
    platforms: platforms.length ? platforms : undefined,
    announceIntervalMs,
  })
  await aggregator.start()

  log.aggregator.info(`started — store=${storePath} search=${searchPath}`)
  log.aggregator.info(`subscribed platforms: ${(platforms.length ? platforms : ['<registry>']).join(', ')}`)
  log.aggregator.info(`indexed jobs at boot: ${store.count()}`)

  // ── HTTP query server ────────────────────────────────────────────────────

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (pathname === '/stats' && req.method === 'GET') {
      return json(res, 200, store.stats())
    }

    if (pathname === '/jobs' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 1000)
      return json(res, 200, store.all(limit))
    }

    const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/)
    if (jobMatch && req.method === 'GET') {
      const hit = store.get(jobMatch[1])
      return hit ? json(res, 200, hit) : json(res, 404, { error: 'not found' })
    }

    if (pathname === '/search' && req.method === 'POST') {
      let query: SearchQuery
      try {
        const raw = JSON.parse(await readBody(req)) as Record<string, unknown>
        if (typeof raw['text'] !== 'string') throw new Error('text required')
        query = {
          text: raw['text'],
          ...(typeof raw['platformId'] === 'string' ? { platformId: raw['platformId'] } : {}),
          ...(typeof raw['limit'] === 'number' ? { limit: raw['limit'] } : {}),
        }
      } catch {
        return json(res, 400, { error: 'invalid search query' })
      }
      const hits = search.search(query).map(hit => ({ ...hit, indexed: store.get(hit.contentHash) }))
      return json(res, 200, hits)
    }

    json(res, 404, { error: 'not found' })
  }

  await new Promise<void>(resolve => http.listen(queryPort, queryHost, resolve))
  const boundPort = (http.address() as AddressInfo).port
  log.aggregator.info(`query server listening on http://${queryHost}:${boundPort}`)

  // ── Heartbeat ────────────────────────────────────────────────────────────

  const heartbeat = setInterval(() => {
    const s = store.stats()
    log.aggregator.info(
      `heartbeat jobs=${s.totalJobs} rejected=${aggregator.rejected} salaryNull=${(s.salaryNullRate * 100).toFixed(1)}%`,
    )
  }, 60_000)
  heartbeat.unref?.()

  await runUntilSignal(async () => {
    clearInterval(heartbeat)
    await new Promise<void>(resolve => http.close(() => resolve()))
    await aggregator.stop()
    store.close()
    search.close()
    await node.stop()
    await flushLogs()
  })
}

main().catch(err => {
  log.error.error(String(err))
  process.exit(1)
})
