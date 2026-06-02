import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { QueryClient } from './client.js'
import type { FanOutOptions } from './client.js'
import type { KalthraxiusNode } from '../p2p-node.js'
import type { QueryProfile } from './types.js'

/**
 * Consumer-facing HTTP gateway (PLAN.md Phase 6). Wraps a QueryClient:
 *
 *   POST /query         — fan out, wait for the merged result, return JSON.
 *   GET/POST /query/stream — Server-Sent Events: each hit is streamed as it
 *                            arrives from the fastest-responding aggregator, so
 *                            the first result reaches the client without waiting
 *                            for the slowest peer (target: <200ms).
 *
 * Uses only the Node stdlib http server — no framework dependency.
 */
export class QueryServer {
  private client: QueryClient
  private server: Server
  private fanOut: FanOutOptions

  constructor(node: KalthraxiusNode, fanOut: FanOutOptions = {}) {
    this.client = new QueryClient(node)
    this.fanOut = fanOut
    this.server = createServer((req, res) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
  }

  /** Start listening. Returns the bound port (0 → an ephemeral port). */
  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>(resolve => this.server.listen(port, host, resolve))
    return (this.server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close(err => (err ? reject(err) : resolve())),
    )
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/query' && req.method === 'POST') {
      return this.handleQuery(req, res)
    }
    if (url.pathname === '/query/stream') {
      return this.handleStream(req, res, url)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  private async handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const profile = await readProfile(req)
    if (!profile) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid profile' }))
      return
    }
    const result = await this.client.query(profile, this.fanOut)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Profile from POST body, or a `q` query param (base64 JSON) for GET/EventSource.
    const profile =
      req.method === 'POST' ? await readProfile(req) : profileFromParam(url.searchParams.get('q'))
    if (!profile) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid profile' }))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const stream = this.client.queryStream(profile, this.fanOut)
    try {
      let next = await stream.next()
      while (!next.done) {
        res.write(`event: hit\ndata: ${JSON.stringify(next.value)}\n\n`)
        next = await stream.next()
      }
      // Generator return value is the summary (answered/failed peers).
      res.write(`event: done\ndata: ${JSON.stringify(next.value)}\n\n`)
    } catch {
      res.write(`event: error\ndata: {}\n\n`)
    } finally {
      res.end()
    }
  }
}

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

async function readProfile(req: IncomingMessage): Promise<QueryProfile | null> {
  try {
    const body = await readBody(req)
    return normalizeProfile(JSON.parse(body))
  } catch {
    return null
  }
}

function profileFromParam(q: string | null): QueryProfile | null {
  if (!q) return null
  try {
    return normalizeProfile(JSON.parse(Buffer.from(q, 'base64').toString('utf8')))
  } catch {
    return null
  }
}

/** Minimal validation: stack must be a string[]; the rest are optional. */
function normalizeProfile(raw: unknown): QueryProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const stack = Array.isArray(r['stack']) ? r['stack'].filter(s => typeof s === 'string') : []
  const profile: QueryProfile = { stack }
  if (typeof r['yoeMax'] === 'number') profile.yoeMax = r['yoeMax']
  if (typeof r['salaryFloor'] === 'number') profile.salaryFloor = r['salaryFloor']
  if (typeof r['location'] === 'string') profile.location = r['location']
  if (typeof r['includeUnknown'] === 'boolean') profile.includeUnknown = r['includeUnknown']
  if (typeof r['limit'] === 'number') profile.limit = r['limit']
  return profile
}
