# Kalthraxius

A decentralized, **qualification-first** job search network. Many cheap scraper
nodes coordinate over libp2p to crawl public job postings; a federated layer of
aggregator nodes indexes and enriches them; users query aggregators and get back
only the jobs they actually qualify for.

Everything is TypeScript on Node, P2P via libp2p (Kademlia DHT + GossipSub,
Noise encryption, Ed25519 identities).

> **Status:** all eight build phases are complete and tested.

## Documentation

| Doc | What's in it |
|---|---|
| **[Wiki → Home](wiki/Home.md)** | Operational docs hub. |
| **[Wiki → Deployment](wiki/Deployment.md)** | Running nodes: bare-metal/systemd, Docker, Compose, Kubernetes — plus the env-var reference, persistence, and networking notes. |
| [PLAN.md](PLAN.md) | Design rationale and phase-by-phase detail. |
| [AGENT_README.md](AGENT_README.md) | Internal invariants, gotchas, and the pinned-dependency rationale. |

This README covers **what it is** and **how to use the API**. For *running* and
*configuring* nodes, go to the [Deployment](wiki/Deployment.md) page.

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

---

## Install & run

```bash
npm ci          # exact, locked deps (see AGENT_README on why `ci`, not `install`)
npm run build   # tsc → dist/
npm test        # full vitest suite

# optional, for browser-mode scraping / the descriptor validator:
npx playwright install chromium   # + `install-deps chromium` on Linux (needs root)
```

Requires **Node.js ≥ 20** (tested on Node 24) and a C toolchain for the
`better-sqlite3` native module. To run a node as a long-lived process, use the
role entrypoints (`npm run start:aggregator`, etc.) — see
[Deployment](wiki/Deployment.md).

---

## Using the API

A Kalthraxius process is a libp2p node (`createNode`) plus whichever role module
you attach. One process can be a scraper, an aggregator, a client, or several at
once. The snippets below are the building blocks; the
[Deployment](wiki/Deployment.md) page wires them into runnable services.

### Quick start: a local 3-node network

Wires an aggregator + a scraper + a query client in one process (the pattern the
integration tests use). Loopback addresses require `allowPrivateAddresses: true`.

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

// Three nodes, dialed together so the DHT + gossip meshes form.
const [aggNode, scraperNode, clientNode] = await Promise.all([spawn(), spawn(), spawn()])
await Promise.all([aggNode.start(), scraperNode.start(), clientNode.start()])
for (const a of [aggNode, scraperNode, clientNode])
  for (const b of [aggNode, scraperNode, clientNode])
    if (a !== b) await a.dial(b.getMultiaddrs()[0]!).catch(() => {})
await new Promise(r => setTimeout(r, 800))

// Aggregator (persists to SQLite files).
const store = new SqliteAggregatorStore('agg-store.db')
const search = new SqliteSearchIndex('agg-search.db')
const agg = new AggregatorNode({ node: aggNode, store, search, platforms: ['greenhouse'] })
await agg.start()
await new Promise(r => setTimeout(r, 600))

// Scraper gossips a (hash-stamped) job.
await publishJob(scraperNode.services.pubsub, stampHashes({
  platformId: 'greenhouse',
  url: 'https://boards.greenhouse.io/acme/jobs/1',
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Python, Django, PostgreSQL. $150k–$180k. 5+ years of experience.',
  salary: '$150,000 - $180,000',
  postedAt: '2026-05-01',
  scrapedAt: Date.now(),
}))

// Client queries — fan out to the aggregator.
await new Promise(r => setTimeout(r, 1000))
const client = new QueryClient(clientNode)
const result = await client.query(
  { stack: ['python', 'django'], yoeMax: 6, salaryFloor: 120_000 },
  { peers: [aggNode.peerId] }, // omit `peers` to discover via the DHT
)
console.log(result.hits.map(h => `${h.job.job.title}  score=${h.score}`))
```

### Scraper

Fetch a board, extract postings, gossip them. Coordination is the DHT
scrape-claim (so peers don't double-crawl).

```ts
import { fetch } from './src/fetcher.js'                  // plain undici/Playwright
import { fetchHardened } from './src/stealth-fetcher.js'  // stealth + jitter + proxy
import { extractJobs } from './src/extractor.js'
import { publishJob } from './src/gossip.js'
import { claimTarget, hasActiveClaim } from './src/scrape-claim.js'

const url = 'https://boards.greenhouse.io/acme'
if (!(await hasActiveClaim(node.services.dht, descriptor.id, url))) {
  await claimTarget(node.services.dht, descriptor.id, url, node.peerId.toString(), 30 * 60_000)
  const { html } = await fetch(url, descriptor)        // or fetchHardened(...) for bot-detected boards
  const { jobs } = await extractJobs(html, descriptor) // applies selectors, stamps contentHash
  for (const job of jobs) await publishJob(node.services.pubsub, job)
}
```

- `fetch(url, descriptor)` — undici for `fetcherMode: 'http'`, Playwright Chromium for `'browser'`.
- `fetchHardened(url, descriptor, opts)` — adds stealth (anti-bot), timing jitter, UA rotation, and an optional `ProxyRotator`.
- `extractJobs(html, descriptor)` — HTML → `RawJob[]` via the descriptor's CSS selectors, stamping the canonical content hash so jobs pass an aggregator's integrity check.

### Aggregator

Indexes the network and serves queries. Needs a node, a store, and a search
index. SQLite adapters are the working default; PostgreSQL + MeiliSearch adapters
exist as production drop-ins.

```ts
import { AggregatorNode } from './src/aggregator/node.js'
import { SqliteAggregatorStore } from './src/aggregator/store-sqlite.js'
import { SqliteSearchIndex } from './src/aggregator/search-sqlite.js'

const agg = new AggregatorNode({
  node,                                            // a started KalthraxiusNode
  store: new SqliteAggregatorStore('aggregator.db'),
  search: new SqliteSearchIndex('aggregator-search.db'),
  platforms: ['greenhouse', 'lever', 'linkedin'],  // defaults to data/platforms.json
})
await agg.start()   // ... await agg.stop() / store.close() / search.close() to shut down
```

On `start()` it subscribes to every platform topic; for each gossiped job it
**verifies the content hash** (rejecting fabricated/tampered jobs), enriches,
persists, and indexes — deduped by content hash; registers the query handler;
and provides the `role:aggregator` rendezvous + announces stats + broadcasts a
bloom filter on a timer. Restart-safe: reopen the same files and every job is
recovered.

### Query client & HTTP/SSE gateway

```ts
import { QueryClient } from './src/query/client.js'
import { QueryServer } from './src/query/server.js'

const client = new QueryClient(node)
const { hits, answered, failed } = await client.query({
  stack: ['python', 'aws'],   // skills — affect SCORE only, never exclude
  yoeMax: 8,                  // hide jobs requiring MORE than 8 years (optional)
  salaryFloor: 150_000,       // hide jobs whose salary max is below this (optional)
  location: 'remote',         // optional; 'remote' or a city
  includeUnknown: true,       // default; false hides jobs with a null filtered field
})
// streaming variant: for await (const hit of client.queryStream({ stack: ['go'] })) { ... }

// Or expose it over HTTP for non-libp2p consumers:
const server = new QueryServer(node)
await server.listen(8080)   // POST /query (JSON), GET|POST /query/stream (SSE)
```

```bash
curl -s localhost:8080/query -H 'content-type: application/json' \
  -d '{"stack":["python","django"],"yoeMax":6,"salaryFloor":120000}'
```

Discovery is automatic (omit `peers` → DHT rendezvous), fan-out is **K=6** with
dedup-by-hash and failover. **The user controls what they see:** filters apply
only where you set a bound; `yoeMax` is a ceiling *you* choose, not a cap
inferred from your experience; skills rank but never exclude; each hit is tagged
`qualification: 'confirmed' | 'assumed'`.

### Enrichment & trust

```ts
import { enrichJob } from './src/enrichment/enrich.js'
import { verifyIntegrity } from './src/job-hash.js'
import { ReputationTracker } from './src/trust/reputation.js'

const enrichment = enrichJob(rawJob)  // { salary, yoe, seniority, skills, ... } + per-field confidences

const tracker = new ReputationTracker()
tracker.recordIntegrity(peerId, verifyIntegrity(job).ok)  // content-hash integrity is tamper-proof
const score = tracker.score(peerId)                       // [0,1], higher = trust more
```

Enrichment is **classical NLP only** (regex, rule-based, curated taxonomy — no
LLM); unknowns are `null` with confidence 0, never guessed. Individual extractors
(`extractSalary`/`extractYoe`/`extractSeniority`/`extractSkills`) are usable
standalone. Trust signals: content-hash **integrity** (weighted highest),
**staleness** probe, cross-aggregator **consistency**, and **feedback** gossip.

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

Validate it against a real or saved page before shipping — the
`validate-descriptor` CLI exits non-zero if a required selector is broken (a CI
gate):

```bash
npm run validate-descriptor src/descriptors/greenhouse-example.json --html sample.html
```

---

## CLIs & scripts

| Command | What it does |
|---|---|
| `npm test` / `npx tsc --noEmit` | Full vitest suite / type-check. |
| `npm run build` | Type-check and emit JS to `dist/`. |
| `npm run start:aggregator` · `start:scraper` · `start:aggregator-scraper` | Run a role as a long-lived process (see [Deployment](wiki/Deployment.md)). |
| `npm run validate-descriptor <descriptor.json> [--url u] [--html file]` | Dry-scrape, report per-selector health, exit 1 on a broken required selector. |
| `npm run download-esco-skills` | Trim the ESCO skills dataset into `data/skills-esco.json` (merged into the taxonomy). Set `ESCO_CSV_URL` or `ESCO_CSV_FILE`. |

Some tests are environment-gated: browser-driven tests skip where Chromium can't
launch; `RUN_STEALTH=1` enables the live bot-detection check; `CHURN_STRESS=1|full`
enables the DHT churn soak. The libp2p churn correctness gate runs on every `npm test`.

---

## Security

- **Transport** is encrypted and mutually authenticated (Noise + Ed25519) — no plaintext job data on the wire.
- **Content integrity** — every job carries a content hash; aggregators reject ones that don't verify, and clients weight aggregators by integrity pass-rate.
- **DHT hardening** — the record validator caps value size and enforces key/value shape against datastore-exhaustion floods (advisory GHSA-32mq-hpph-xfvr, mitigated in-code).
- **Do not run `npm audit fix --force`** — it would break the deliberately v2-pinned libp2p stack. See [AGENT_README.md](AGENT_README.md).
