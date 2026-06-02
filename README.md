# Kalthraxius

A decentralized, **qualification-first** job search network. Many cheap scraper
nodes coordinate over libp2p to crawl public job postings; a federated layer of
aggregator nodes indexes and enriches them; users query aggregators and get back
only the jobs they actually qualify for.

> **Status:** all eight build phases are complete and tested. See
> [PLAN.md](PLAN.md) for the design and [AGENT_README.md](AGENT_README.md) for
> the non-obvious internals and gotchas.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start: a local 3-node network](#quick-start-a-local-3-node-network)
- [Node roles](#node-roles)
  - [Scraper](#scraper)
  - [Aggregator](#aggregator)
  - [Query client](#query-client)
  - [HTTP / SSE gateway](#http--sse-gateway)
- [Writing a platform descriptor](#writing-a-platform-descriptor)
- [Enrichment](#enrichment)
- [Trust & reputation](#trust--reputation)
- [CLIs & scripts](#clis--scripts)
- [Configuration reference](#configuration-reference)
- [Testing](#testing)
- [Security notes](#security-notes)

---

## How it works

```
 ┌──────────┐   scrape + hash    ┌───────────────┐   gossip (per platform)   ┌──────────────┐
 │ job board │ ─────────────────▶ │ scraper node  │ ─────────────────────────▶ │ aggregator   │
 └──────────┘   (descriptor)     │ (libp2p+DHT)  │   /kalthraxius/jobs/<p>/v1 │ node         │
                                  └───────────────┘                           │  • enrich    │
                                         │ DHT scrape-claims (dedup work)      │  • index     │
                                         ▼                                     │  • announce  │
                                  ┌───────────────┐                           └──────┬───────┘
                                  │ Kademlia DHT  │◀── role:aggregator rendezvous ───┘
                                  └───────────────┘            ▲
                                                               │ fan-out K=6, dedup, rank
                                                        ┌──────┴───────┐
                                                        │ query client │  REST / SSE
                                                        │  (user)      │
                                                        └──────────────┘
```

1. **Scrapers** fetch a job board (per a JSON *descriptor*), extract postings,
   stamp a content hash, and gossip them on a per-platform topic. They
   coordinate via DHT **scrape-claims** so two scrapers don't crawl the same
   target.
2. **Aggregators** subscribe to every platform topic, verify each job's content
   hash, **enrich** it (salary / YOE / seniority / skills via classical NLP),
   persist + index it, and periodically **announce** themselves on the DHT.
3. **Clients** discover aggregators on the DHT, **fan out** a query to K peers,
   dedup by content hash, and merge a ranked result — over a libp2p protocol or
   an HTTP/SSE gateway.

Everything is TypeScript on Node, P2P via libp2p (Kademlia DHT + GossipSub,
Noise encryption, Ed25519 identities).

---

## Requirements

- **Node.js ≥ 20** (developed on Node 24; uses `--experimental-strip-types` for
  the CLIs, native ESM with `.js` import specifiers).
- A C toolchain for `better-sqlite3` (native module).
- **Playwright Chromium** only if you use browser-mode scraping/extraction:
  `npx playwright install chromium` (and `npx playwright install-deps chromium`
  on Linux, which needs root).

---

## Install

```bash
npm install
# optional, for browser-mode scraping / the descriptor validator:
npx playwright install chromium
```

There is no build step required to run via the CLIs (they strip types at
runtime). To emit JS: `npm run build` (outputs to `dist/`).

---

## Quick start: a local 3-node network

This wires an aggregator + a scraper + a query client in one process — the same
pattern the integration tests use. Loopback addresses require
`allowPrivateAddresses: true`.

```ts
import { generateIdentity } from './src/identity.js'
import { createNode } from './src/p2p-node.js'
import { AggregatorNode } from './src/aggregator/node.js'
import { SqliteAggregatorStore } from './src/aggregator/store-sqlite.js'
import { SqliteSearchIndex } from './src/aggregator/search-sqlite.js'
import { publishJob } from './src/gossip.js'
import { stampHashes } from './src/extractor.js'
import { QueryClient } from './src/query/client.js'

const LISTEN = ['/ip4/127.0.0.1/tcp/0']
const spawn = async () =>
  createNode({ privateKey: await generateIdentity(), listenAddresses: LISTEN, allowPrivateAddresses: true })

// 1. Three nodes: aggregator, scraper, client.
const [aggNode, scraperNode, clientNode] = await Promise.all([spawn(), spawn(), spawn()])
await Promise.all([aggNode.start(), scraperNode.start(), clientNode.start()])

// 2. Dial them together so the DHT + gossip meshes form.
for (const a of [aggNode, scraperNode, clientNode])
  for (const b of [aggNode, scraperNode, clientNode])
    if (a !== b) await a.dial(b.getMultiaddrs()[0]!).catch(() => {})
await new Promise(r => setTimeout(r, 800))

// 3. Start the aggregator (persists to SQLite files).
const store = new SqliteAggregatorStore('agg-store.db')
const search = new SqliteSearchIndex('agg-search.db')
const agg = new AggregatorNode({ node: aggNode, store, search, platforms: ['greenhouse'] })
await agg.start()
await new Promise(r => setTimeout(r, 600))

// 4. Scraper gossips a (hash-stamped) job.
const job = stampHashes({
  platformId: 'greenhouse',
  url: 'https://boards.greenhouse.io/acme/jobs/1',
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Python, Django, PostgreSQL. $150k–$180k. 5+ years of experience.',
  salary: '$150,000 - $180,000',
  postedAt: '2026-05-01',
  scrapedAt: Date.now(),
})
await publishJob(scraperNode.services.pubsub, job)

// 5. Client queries — fan out to the aggregator.
await new Promise(r => setTimeout(r, 1000))
const client = new QueryClient(clientNode)
const result = await client.query(
  { stack: ['python', 'django'], yoeMax: 6, salaryFloor: 120_000 },
  { peers: [aggNode.peerId] }, // omit `peers` to discover via the DHT
)
console.log(result.hits.map(h => `${h.job.job.title}  score=${h.score}`))
```

---

## Node roles

A Kalthraxius process is built from a libp2p node (`createNode`) plus whichever
role module you attach. One process can be a scraper, an aggregator, a client,
or several at once.

### Scraper

A scraper fetches a board, extracts postings, and gossips them. The two core
pieces are the **fetcher** and the **extractor**; coordination is the DHT
scrape-claim.

```ts
import { fetch } from './src/fetcher.js'              // plain undici/Playwright
import { fetchHardened } from './src/stealth-fetcher.js' // stealth + jitter + proxy
import { extractJobs } from './src/extractor.js'
import { publishJob } from './src/gossip.js'
import { claimTarget, hasActiveClaim } from './src/scrape-claim.js'

// Avoid double-crawling: claim the target in the DHT first (TTL 30 min).
const url = 'https://boards.greenhouse.io/acme'
if (!(await hasActiveClaim(node.services.dht, descriptor.id, url))) {
  await claimTarget(node.services.dht, descriptor.id, url, node.peerId.toString(), 30 * 60_000)

  const { html } = await fetch(url, descriptor)           // or fetchHardened(...)
  const { jobs } = await extractJobs(html, descriptor)    // applies selectors, stamps contentHash
  for (const job of jobs) await publishJob(node.services.pubsub, job)
}
```

- **`fetch(url, descriptor)`** — undici for `fetcherMode: 'http'`, Playwright
  Chromium for `'browser'`.
- **`fetchHardened(url, descriptor, opts)`** — adds stealth (anti-bot), timing
  jitter, UA rotation, and an optional `ProxyRotator`. Use it against boards
  with bot detection.
- **`extractJobs(html, descriptor)`** — turns HTML into `RawJob[]` via the
  descriptor's CSS selectors and **stamps the canonical content hash** (so the
  job passes an aggregator's integrity check). Pass a shared Playwright
  `browser` to amortise launch across pages.

### Aggregator

An aggregator indexes the network and serves queries. It needs a libp2p node, a
store, and a search index. The SQLite adapters are the working default
(in-process, no external services); PostgreSQL + MeiliSearch adapters exist as
production drop-ins.

```ts
import { AggregatorNode } from './src/aggregator/node.js'
import { SqliteAggregatorStore } from './src/aggregator/store-sqlite.js'
import { SqliteSearchIndex } from './src/aggregator/search-sqlite.js'

const store = new SqliteAggregatorStore('aggregator.db')
const search = new SqliteSearchIndex('aggregator-search.db')

const agg = new AggregatorNode({
  node,                         // a started KalthraxiusNode
  store,
  search,
  // platforms defaults to data/platforms.json; override to a subset if you like
  platforms: ['greenhouse', 'lever', 'linkedin'],
  announceIntervalMs: 30_000,   // DHT announce + bloom broadcast cadence
})
await agg.start()
// ... runs until:
await agg.stop()
store.close()
search.close()
```

What it does on `start()`: subscribes to every platform topic; for each gossiped
job it **verifies the content hash** (rejecting fabricated/tampered jobs),
enriches, persists, and indexes — deduped by content hash; registers the query
protocol handler; and provides the `role:aggregator` rendezvous + announces
stats + broadcasts a bloom filter of held hashes on a timer.

Persistence is real: point the adapters at the same files after a restart and
every job is recovered (no data loss).

### Query client

```ts
import { QueryClient } from './src/query/client.js'
const client = new QueryClient(node)

// One-shot: fan out, merge, return ranked results.
const { hits, answered, failed } = await client.query({
  stack: ['python', 'aws'],   // skills — affect SCORE only, never exclude
  yoeMax: 8,                  // hide jobs requiring MORE than 8 years (optional)
  salaryFloor: 150_000,       // hide jobs whose salary max is below this (optional)
  location: 'remote',         // optional; 'remote' or a city
  includeUnknown: true,       // default; false hides jobs with a null filtered field
  limit: 50,
})

// Streaming: yields hits as the fastest aggregators answer (first result fast).
for await (const hit of client.queryStream({ stack: ['go'] })) {
  console.log(hit.job.job.title)
}
```

Discovery is automatic: omit `peers` and the client finds aggregators on the
DHT rendezvous, queries up to **K=6** in parallel, dedups by content hash, and
**fails over** to spare peers if some don't answer.

**Query semantics (the user is in control):** filters only apply where you set a
bound. `yoeMax` is a ceiling *you* choose, not a cap inferred from your
experience — set it to your real years, higher ("show me 5+"), or omit it.
Skills never exclude a job; they rank it. Each hit is tagged
`qualification: 'confirmed' | 'assumed'` (`assumed` = a filtered field was null
and `includeUnknown` let it through).

### HTTP / SSE gateway

Expose the query client over HTTP for non-libp2p consumers (a web UI, curl):

```ts
import { QueryServer } from './src/query/server.js'

const server = new QueryServer(node)        // wraps a QueryClient
const port = await server.listen(8080)
// ... later: await server.close()
```

```bash
# REST: fan out, wait, return merged JSON.
curl -s localhost:8080/query \
  -H 'content-type: application/json' \
  -d '{"stack":["python","django"],"yoeMax":6,"salaryFloor":120000}'

# SSE: stream hits as they arrive (event: hit ...), then event: done with the summary.
curl -N localhost:8080/query/stream \
  -H 'content-type: application/json' \
  -d '{"stack":["go","kubernetes"]}'
```

---

## Writing a platform descriptor

A descriptor is JSON config per job board: how to fetch it, how to paginate, and
the CSS selectors to extract each field. See
[src/descriptors/greenhouse-example.json](src/descriptors/greenhouse-example.json).

```jsonc
{
  "id": "greenhouse",                 // platform id (also the gossip topic + claim namespace)
  "name": "Greenhouse",
  "baseUrl": "https://boards.greenhouse.io/acme/",
  "fetcherMode": "http",              // "http" (undici) | "browser" (Playwright)
  "rateLimit": { "requestsPerMinute": 30 },
  "pagination": { "type": "page", "pageParam": "page", "pageSize": 25, "maxPages": 5 },
  "selectors": {
    "jobList": ".opening",            // required: each job row
    "jobLink": "a",                   // required: link (→ absolute url via baseUrl)
    "title": ".opening-title",        // required
    "company": ".company",
    "location": ".location",
    "description": ".content",
    "salary": ".comp",                // optional
    "postedAt": ".date"               // optional
  }
}
```

Validate a descriptor against a real (or saved) page before shipping it — see
[`validate-descriptor`](#clis--scripts).

---

## Enrichment

Enrichment is **classical NLP only — regex, rule-based, curated taxonomy. No
LLM.** It runs async and decoupled from ingest: raw lands immediately, enriched
fields fill in behind.

Aggregators enrich on ingest automatically. To drive it directly:

```ts
import { enrichJob } from './src/enrichment/enrich.js'
const enrichment = enrichJob(rawJob)
// → { salary, yoe, seniority, skills, schemaVersion, enrichedAt } with per-field confidences
```

Extractors are individually usable: `extractSalary`, `extractYoe`,
`extractSeniority` (in `src/enrichment/`), and `extractSkills` (taxonomy +
fuzzy matching). Unknown values are `null` with confidence 0 — never guessed.

**Skills taxonomy** is a hand-curated seed ([data/skills-seed.json](data/skills-seed.json),
committed) plus an optional ESCO merge — run
[`download-esco-skills`](#clis--scripts) to raise recall.

**Schema migrations:** bump `ENRICHMENT_SCHEMA_VERSION` in
[src/types.ts](src/types.ts) when an extractor changes, then run the batched
re-enrichment:

```ts
import { runMigration } from './src/enrichment/migration-job.js'
const report = await runMigration(db, { batchSize: 200, onProgress: (n, total) => ... })
```

---

## Trust & reputation

Clients can score aggregators so they prefer trustworthy ones. Content-hash
integrity is the only tamper-proof signal and is weighted highest.

```ts
import { verifyIntegrity } from './src/job-hash.js'
import { ReputationTracker } from './src/trust/reputation.js'
import { probeStaleness } from './src/trust/staleness.js'
import { scoreConsistency } from './src/trust/consistency.js'

const tracker = new ReputationTracker()
// On each received job, record whether its content hash verified:
tracker.recordIntegrity(peerId, verifyIntegrity(job).ok)
// Fold in other signals as you gather them:
tracker.setConsistency(peerId, /* from scoreConsistency(announcements) */ 0.9)
const score = tracker.score(peerId)   // [0,1], higher = trust more
```

- **Integrity** — recompute and compare the content hash; a mismatch = fabricated/tampered.
- **Staleness probe** — sample old job URLs and re-check them via an injectable
  `URLChecker` (`(url) => 'alive' | 'dead'`).
- **Consistency** — compare an aggregator's announced stats against the peer
  consensus (median).
- **Feedback gossip** — broadcast `{ jobId, reason }` signals; a `FeedbackLedger`
  accumulates them per aggregator.

---

## CLIs & scripts

| Command | What it does |
|---|---|
| `npm test` | Run the full vitest suite. |
| `npm run build` | Type-check and emit JS to `dist/`. |
| `npm run validate-descriptor <descriptor.json> [--url <u>] [--html <file>]` | Dry-scrape a page and report per-selector health. Exits **1** if a required selector is broken — usable as a CI gate. `--html` validates a saved file offline. |
| `npm run download-esco-skills` | Download + trim the ESCO skills dataset into `data/skills-esco.json` (merged into the taxonomy at runtime). Set `ESCO_CSV_URL` or `ESCO_CSV_FILE`. |

```bash
# validate a descriptor against a saved page (no network):
npm run validate-descriptor src/descriptors/greenhouse-example.json --html sample.html
```

---

## Configuration reference

| Where | Option | Default | Notes |
|---|---|---|---|
| `createNode` | `allowPrivateAddresses` | `false` | **Set `true` for local/loopback clusters** (tests, dev), else the DHT routing table won't populate. Leave `false` in production. |
| `createNode` | `bootstrapAddresses` | – | Multiaddrs of known peers to bootstrap from. |
| `AggregatorNode` | `platforms` | `data/platforms.json` | Which per-platform topics to subscribe to. |
| `AggregatorNode` | `announceIntervalMs` | `30000` | DHT announce + bloom broadcast cadence. |
| `AggregatorNode` | `verifyContentHash` | `true` | Reject jobs whose content hash doesn't match. Set `false` only for fixtures with placeholder hashes. |
| `QueryClient.query` | `k` | `6` | Fan-out breadth. |
| `QueryClient.query` | `peers` | – | Explicit peers; omit to discover via the DHT. |
| `fetchHardened` | `proxies`, `jitterMs`, `userAgents` | – | Stealth/proxy/jitter knobs. |
| Env | `DATABASE_URL`, `MEILI_HOST` | – | For the (stubbed) Postgres/Meili aggregator adapters. |
| Env | `RUN_STEALTH=1` | – | Enables the live bot-detection test. |
| Env | `CHURN_STRESS=1\|full` | – | Enables the opt-in DHT churn soak (`full` = 50 nodes / 30 min). |

Identities persist across restarts:

```ts
import { generateIdentity, saveIdentity, loadIdentity } from './src/identity.js'
const id = await generateIdentity()
saveIdentity(id, 'node.key')
// next boot:
const sameId = loadIdentity('node.key')   // same peer id, recognized by peers
```

---

## Testing

```bash
npm test                      # full suite (vitest, forks pool for better-sqlite3)
npx tsc --noEmit              # type-check (keep this clean)
```

Browser-driven tests (extractor/validator) **skip automatically** where Chromium
can't launch; install Playwright deps to run them. The DHT churn soak and the
live stealth check are env-gated (see the config table). The libp2p churn
correctness gate runs on every `npm test`.

---

## Security notes

- **Transport** is encrypted and mutually authenticated (Noise + Ed25519). No
  plaintext job data on the wire.
- **Content integrity** — every job carries a content hash; aggregators reject
  ones that don't verify, and clients can weight aggregators by their integrity
  pass-rate.
- **DHT hardening** — the record validator caps value size and enforces key/value
  shape to prevent datastore-exhaustion floods
  (advisory GHSA-32mq-hpph-xfvr; mitigated in-code — see
  [AGENT_README.md](AGENT_README.md)). **Do not run `npm audit fix --force`** —
  it would break the deliberately v2-pinned libp2p stack.

---

For design rationale and phase-by-phase detail see [PLAN.md](PLAN.md); for
internal invariants, gotchas, and the pinned-dependency rationale see
[AGENT_README.md](AGENT_README.md).
