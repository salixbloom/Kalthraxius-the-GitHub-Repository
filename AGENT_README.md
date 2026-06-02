# AGENT_README — context for future agents

Read this before touching the codebase. It captures the non-obvious decisions
and traps that aren't visible from the code or git history. For *what* we're
building and the phase roadmap, see [PLAN.md](PLAN.md).

Kalthraxius is a decentralized, qualification-first job search network: many
cheap scraper nodes coordinate over libp2p; aggregator nodes index and serve
queries; users get back only jobs they qualify for. Node.js + TypeScript.

**Phase status:** ALL phases (1–8) are built and green — scraper core, libp2p
identity, DHT + GossipSub + coordination, enrichment, the aggregator node, the
query layer, trust & reputation, and hardening. The plan is complete; further
work is the "ongoing" hardening track (Phase 8) and operational concerns. The
Phase 3 DHT churn test is a HARD GATE and passes.

## Commands

```
npm test                      # vitest run (full suite)
npx tsc --noEmit              # typecheck — keep this clean, it's the gate
npm run download-esco-skills  # optional: ESCO_CSV_URL or ESCO_CSV_FILE env required
```

- **vitest uses `pool: 'forks'`** (vitest.config.ts) — required for
  `better-sqlite3` native-module compatibility. Don't switch to threads.
- tsconfig is `NodeNext` ESM. **Imports must use `.js` extensions** even for
  `.ts` source (e.g. `import { x } from './foo.js'`). This is not optional.

---

## libp2p: the load-bearing constraint (DO NOT BREAK)

The **entire libp2p stack is pinned to EXACT `@libp2p/interface` v2 versions**
(no `^`) in package.json. This is deliberate and fragile.

- ChainSafe's gossipsub has **no v3 release**; mixing `libp2p@3.x` with
  gossipsub-on-v2 creates a split-brain where npm nests a second interface copy.
  At runtime the registrar hands gossipsub mismatched Stream/Connection objects →
  **outbound stream creation silently fails → no gossip, degraded DHT.** Symptoms
  are silent: subscriptions don't propagate, DHT put/get fail with no error.
- **Do not let any libp2p package float to v3** until ChainSafe ships a v3
  gossipsub, at which point migrate the *whole* stack together.
- Use `@chainsafe/libp2p-yamux`, **never** `@libp2p/yamux` (deprecated + an
  import bug that throws at load).
- Full rationale + the four `kadDHT` config gotchas (allowQueryWithZeroPeers,
  passthroughMapper for loopback, plain-function validators/selectors, key-prefix
  keying) live in the auto-memory file `memory/libp2p-v2-stack-pin.md`. Read it
  before editing [p2p-node.ts](src/p2p-node.ts).
- **Security advisory GHSA-32mq-hpph-xfvr (CVE-2026-45783, CVSS 7.5) is mitigated
  in OUR code, not by upgrading.** kad-dht `<16.2.6` stores PUT_VALUE records
  without validating short keys, enabling an unauthenticated peer to exhaust a
  server node's datastore (RAM for us — default MemoryDatastore). The fix exists
  ONLY on the v3 line (16.2.6+), which we can't adopt (see above). Instead our
  DHT validator ([dht-validator.ts](src/dht-validator.ts)) enforces a value size
  cap (`MAX_RECORD_VALUE_BYTES`) + exact key shape (`/kalthraxius/<sha256>`) +
  JSON-object shape, so flood records are rejected before storage. The old
  validator was a no-op `async () => {}` that stored everything — that was the
  real hole. **Do NOT revert the validator to a no-op** and do NOT run
  `npm audit fix --force` (it pulls kad-dht@16 → v3 split-brain). Revisit when
  the stack moves to v3.
- `@libp2p/crypto`'s nested interface-v3 copy is **type-only and harmless**; the
  skew it causes is bridged in [identity.ts](src/identity.ts) by sourcing the key
  type from the crypto module's own signature. Don't "fix" it back to
  `@libp2p/interface`.

## Tests for the P2P layer

- Helpers in [src/__tests__/helpers/network.ts](src/__tests__/helpers/network.ts):
  `spawnNode` / `spawnConnectedCluster(n)` / `stopAll`. Test nodes use
  `allowPrivateAddresses: true` so loopback addrs stay in the routing table.
- The churn test (`churn.test.ts`) emits a cosmetic `TimeoutNaNWarning: NaN is
  not a number` during forced node shutdown. **It is benign** (absent on clean
  `.stop()`); do not chase it.

---

## Phase 4 enrichment: architecture & invariants

Classical NLP only — **regex, rule-based, curated taxonomy. No LLM, ever.**

- **Two schema versions, independent — don't conflate them:**
  - SQLite `PRAGMA user_version` ([migrations.ts](src/migrations.ts)) tracks
    *table shapes*. Adding a column = a new `Migration` appended to `MIGRATIONS`
    (contiguous, 1-based). The runner refuses downgrades.
  - `ENRICHMENT_SCHEMA_VERSION` in [types.ts](src/types.ts) tracks *which
    extractor revision* last processed a row. **Bump it whenever an extractor
    changes in a way that should reprocess existing data** — that bump is the
    migration trigger: the worker re-queues everything `WHERE schema_version <
    CURRENT`.
- **Raw is immutable.** Enriched fields live in a separate `enrichments` table
  (FK + `ON DELETE CASCADE` to `jobs`), never as columns on `jobs`. Re-enrichment
  is a clean row rewrite (upsert).
- **The worker must never block ingest** ([enrichment/worker.ts](src/enrichment/worker.ts)):
  it only reads `jobs` / writes `enrichments`, batches are transaction-wrapped,
  and it `setImmediate`-yields between batches. If you add work to the loop, keep
  it yielding.
  - **Gotcha already paid for:** `stop()` must resolve the in-flight idle-wait
    promise (`wakeIdle`), not just `clearTimeout` it — otherwise the loop awaits a
    promise whose timer is gone and `stop()` deadlocks. Preserve this.
- **Extractor null policy:** when a field can't be extracted confidently, return
  `value: null, confidence: 0`. Don't guess. Every field carries a per-field
  confidence; seniority has a deliberate low-confidence (0.4) "mid" soft-default
  for bare engineer/developer titles.
- **Skills taxonomy is hybrid:**
  - [data/skills-seed.json](data/skills-seed.json) (~130 curated tech skills) is
    **committed** and is the offline default. Curated entries win on id collision.
  - `npm run download-esco-skills` writes `data/skills-esco.json`, which is
    **gitignored** (generated artifact) and merged in at runtime *if present* by
    `buildTaxonomy()`. Merge is opt-in by file presence — no runtime network.
  - The taxonomy is cached in-process; call `resetTaxonomyCache()` if a test
    changes the underlying files.

## Phase 4 quality gates (keep these passing)

Asserted in [enrichment.integration.test.ts](src/__tests__/enrichment.integration.test.ts)
and [worker.test.ts](src/__tests__/worker.test.ts) against the 10-posting /
3-platform fixture: salary null-rate <10% on visible-salary postings, seniority
accuracy >90% on explicit titles, skills recall >80% on bullet lists,
throughput >1000 jobs/min single-core, re-enrichment without corruption.
**Instrument null rates from day one** (per the risk register: salary null >30%
on any platform = the regex needs work).

---

## Phase 5 aggregator: architecture & invariants

The aggregator ([src/aggregator/](src/aggregator/)) is the indexing/serving node:
subscribes to every per-platform job topic, enriches each gossiped job on ingest
(Phase 4 pipeline), persists + indexes it, and periodically announces itself.

- **Storage is interface + adapters — the SQLite adapters are the working
  default, PG/Meili are stubs:**
  - `AggregatorStore` ([store.ts](src/aggregator/store.ts)) is the system of
    record; `SearchIndex` ([search.ts](src/aggregator/search.ts)) is a derived,
    rebuildable full-text index. They're separate on purpose — the store is
    authoritative, the index can be rebuilt from it.
  - `SqliteAggregatorStore` + `SqliteSearchIndex` (FTS5) run in-process and
    offline; all aggregator logic and tests use them. `PostgresAggregatorStore`
    and `MeiliSearchIndex` are **stubs that throw `NotImplemented`** — fill them
    in when infra lands (env: `DATABASE_URL`, `MEILI_HOST`). Don't wire real
    services into the default path.
  - The aggregator DB is its **own** file, distinct from a scraper's `JobCache`.
    It stores (raw + enrichment) as one unit (enrichment as a JSON column), so
    there's no cross-table join.
- **Dedup by content hash is the core invariant.** Gossip delivers the same job
  from multiple scrapers; `store.upsert` and `search.index` are both idempotent
  by `contentHash` (FTS5 has no UPSERT, so the index does delete-then-insert).
  Never let a duplicate hash create two rows.
- **Restart = no data loss.** Store/index are persistent SQLite files; a
  restarted aggregator reopens them, recovers everything, and re-subscribes.
- **Platform discovery is the static registry** ([data/platforms.json](data/platforms.json)
  via [platforms.ts](src/platforms.ts)). The aggregator subscribes to one topic
  per listed platform. Adding a platform = editing that JSON (fits Model A).
- **DHT announcement** ([announce.ts](src/aggregator/announce.ts)): publishes
  `role:aggregator` + self-reported `AggregatorStats` under a `kalthraxius`-keyed
  DHT record. Stats are **self-reported and untrusted** — Phase 7 verifies them.
  The only guarantee here is they match the node's own DB at publish time.
- **Bloom gossip** ([bloom.ts](src/aggregator/bloom.ts) +
  [bloom-gossip.ts](src/aggregator/bloom-gossip.ts)): periodic broadcast of a
  bloom filter over the held content-hash set on one global topic
  (`/kalthraxius/aggregator/bloom/v1`). **False positives are fine, false
  negatives are not** — the filter must never deny a hash it actually holds.
  Dependency-free (double-hashing into a packed bit array); serialized with a
  small header for the wire.
- The announce timer is `unref()`'d so it can't keep the process alive on its
  own; `AggregatorNode.stop()` clears it and unsubscribes but does **not** close
  the store/search (the caller owns their lifecycle).

## Phase 5 quality gates (keep these passing)

In [aggregator-node.test.ts](src/__tests__/aggregator-node.test.ts) (libp2p e2e)
and [aggregator-store.test.ts](src/__tests__/aggregator-store.test.ts): all jobs
gossiped by 3 scrapers across platforms get indexed; the same job from multiple
scrapers dedups to one; the DHT announcement's stats equal the store's; a
restart recovers all jobs and keeps ingesting. Bloom correctness (no false
negatives, FP rate near target, wire round-trip) in
[bloom.test.ts](src/__tests__/bloom.test.ts).

---

## Phase 6 query layer: architecture & invariants

The query layer ([src/query/](src/query/)) is the consumer-facing path. Guiding
principle (from the project owner): **the user controls what they see — we serve
intent, we don't gatekeep.**

- **`QueryProfile`** ([query/types.ts](src/query/types.ts)) — every filter bound
  is OPTIONAL; absent = no filtering on that axis.
  - `yoeMax?` is a **user-chosen ceiling, not a cap we infer**. "I have 3 YOE but
    show me 5+" is valid: they set `yoeMax: 8` and see those jobs. Never derive a
    YOE limit from the user's actual experience.
  - `includeUnknown` (default **true**): a job whose enriched field is `null`
    passes filters touching that field (don't punish a job for our extraction
    gap). When `false`, a null on any *filtered* field excludes the job. A null
    on an *unfiltered* axis never matters. Passing-on-null is surfaced as
    `qualification: 'assumed'` vs `'confirmed'` on each hit — the UI can badge
    it, but we never hide it.
  - **Skills NEVER exclude.** Stack overlap drives the SCORE only; a zero-overlap
    job still appears (ranked lower). This is deliberate — not our job to decide
    a job is irrelevant.
- **Pipeline** ([query/engine.ts](src/query/engine.ts)): hard filter → score
  (normalised stack overlap) → rank. Ranking = `overlap*10 + freshness`, so a
  strong skill match always outranks mere recency. Freshness decays linearly to
  0 at 60 days (the "60+ day penalty"): a 2-day posting outranks an identical
  90-day one. Engine is pure/sync — aggregators run it locally; the client
  re-merges.
- **Distributed query path:**
  - Discovery ([query/discovery.ts](src/query/discovery.ts)): all aggregators
    `provide` ONE well-known rendezvous CID; clients `findProviders` to
    **enumerate** the live set (no peer id needed up front). Provider records are
    refreshed on the announce timer.
  - Protocol ([query/protocol.ts](src/query/protocol.ts)): `/kalthraxius/query/1.0.0`,
    one length-prefixed JSON round-trip (`lpStream`), 1 MB cap, timeouts on both
    sides. Aggregator registers the handler in `AggregatorNode.start()`.
  - Fan-out ([query/client.ts](src/query/client.ts)): query **K=6** peers in
    parallel, **dedup by content hash** (keep higher score), merge + re-rank.
    `queryStream` yields hits in arrival order (first result as soon as the
    fastest peer answers → SSE <200ms) and **fails over**: a peer that throws is
    recorded in `failed` and replaced from spare discovered peers.
  - Gateway ([query/server.ts](src/query/server.ts)): stdlib `http` only (no
    framework). `POST /query` (JSON) and `GET|POST /query/stream` (SSE:
    `event: hit` per result, `event: done` with the answered/failed summary).
- **Gotcha already paid for:** an aggregator's `stop()` (and the gossip
  unsubscribe in [gossip.ts](src/gossip.ts)) must tolerate the underlying libp2p
  node already being stopped — `pubsub.unsubscribe` throws "Pubsub is not
  started" otherwise. The unsubscribe is wrapped in try/catch; preserve that, it
  models a real crashed-node path.

## Phase 6 quality gates (keep these passing)

Engine unit tests in [query-engine.test.ts](src/__tests__/query-engine.test.ts)
(5 profiles, yoeMax/salary exclusion, includeUnknown toggle, freshness ranking,
skills-never-exclude). Distributed gates in
[query-fanout.test.ts](src/__tests__/query-fanout.test.ts): same job on 3
aggregators returns once (dedup), dead aggregator doesn't block live ones
(failover), DHT discovery finds aggregators, first SSE hit arrives fast, REST
returns merged JSON.

---

## Phase 7 trust & reputation: architecture & invariants

Defends the federation against faulty/malicious aggregators
([src/trust/](src/trust/) + [src/job-hash.ts](src/job-hash.ts)).

- **Canonical two-part job identity** ([job-hash.ts](src/job-hash.ts)) — this is
  foundational; producer and verifier MUST agree:
  - `locationHash = sha256(platformId + url)` — the posting's ADDRESS. Groups all
    copies of the same listing across aggregators. **Same locationHash +
    different contentHash = two aggregators disagree on the same posting = a
    tamper signal** (the hook for catching bad actors).
  - `contentHash = sha256(canonical content fields)` — content fields only,
    length-prefixed-by-key so text can't shift across field boundaries.
    **EXCLUDES `scrapedAt`** (volatile — two honest scrapers must agree) and
    enrichment (derived). Before Phase 7 there was NO canonical job hash;
    `contentHash` was set externally. If you change the canonical field set, you
    invalidate every stored hash — treat it like a wire-format change.
- **Integrity is the only tamper-proof signal — weight it highest** (risk
  register). `verifyIntegrity(job)` recomputes and compares. `AggregatorNode.ingest`
  REJECTS mismatches (doesn't store them) and counts them (`node.rejected`),
  gated by `verifyContentHash` (default **true**; set false for fixtures with
  placeholder hashes — the pre-Phase-7 aggregator/query tests do this).
- **Reputation scoring** ([trust/reputation.ts](src/trust/reputation.ts)):
  weighted blend, integrity-dominant (`DEFAULT_WEIGHTS` integrity 0.5, staleness
  0.2, consistency 0.2, feedback 0.1). An integrity failure must hurt more than
  any other single signal — preserve that ordering if you retune.
  `ReputationTracker` accumulates observations per peerId over a session.
- **Cross-aggregator consistency** ([trust/consistency.ts](src/trust/consistency.ts)):
  compares announced `salaryNullRate` (a scale-free quality ratio, not raw
  totals which legitimately vary) against the **median** consensus (robust to a
  lone liar). <3 aggregators → neutral 1.0 (don't condemn on thin evidence). A
  broken salary regex surfaces here as an anomalous null-rate.
- **Staleness probe** ([trust/staleness.ts](src/trust/staleness.ts)): samples N
  old jobs and re-checks URLs via an **injectable `URLChecker`** (`(url) =>
  'alive'|'dead'`). Production wires the real fetcher; tests inject a stub. A
  checker that throws = indeterminate (skipped, doesn't inflate the rate).
- **Feedback gossip** ([trust/feedback.ts](src/trust/feedback.ts)): tiny
  `{jobId, reason, servedBy, at}` signals on one global topic
  (`/kalthraxius/feedback/v1`). `FeedbackLedger` accumulates per-aggregator,
  deduped by `(jobId, reason)` so one user can't spam one complaint. Drives the
  feedback term of reputation.

## Phase 7 quality gates (keep these passing)

[trust.test.ts](src/__tests__/trust.test.ts): tampering any content field →
hash mismatch; 100 jobs / 30 dead URLs → ~30% staleness; broken-regex
aggregator scores lower than healthy; integrity dominates reputation.
[trust-gossip.test.ts](src/__tests__/trust-gossip.test.ts) (libp2p e2e): a
feedback signal reaches another peer within ~2 gossip cycles; a fabricated job
gossiped to an aggregator is rejected while the clean one is stored.

---

## Phase 8 hardening: architecture & invariants

The "ongoing" hardening track (PLAN.md Phase 8).

- **HTML→RawJob extractor** ([extractor.ts](src/extractor.ts)) — this filled a
  real gap: the fetcher returned raw HTML but NOTHING parsed it into jobs.
  `extractJobs(html, descriptor)` applies the descriptor's CSS selectors via
  Playwright's Chromium (`page.setContent`, no new dep) and **stamps the
  canonical `contentHash`** (via [job-hash.ts](src/job-hash.ts)) on every job —
  this is what makes a real scraper's output pass the Phase 7 integrity gate.
  Production scrapers MUST route extraction through here (or call `stampHashes`)
  so jobs carry a verifiable hash. Pass a shared `browser` to amortise launch.
- **Stealth fetcher** ([stealth-fetcher.ts](src/stealth-fetcher.ts)) — adds
  `playwright-extra` + `puppeteer-extra-plugin-stealth` (the only new prod deps
  this phase — NOT part of the pinned libp2p tree, fine to update), plus timing
  jitter, UA rotation, and a `ProxyRotator` adapter (`StaticProxyRotator`
  round-robins a pool). `fetchHardened` is the drop-in replacement for
  `fetcher.fetch`. The plain [fetcher.ts](src/fetcher.ts) remains for simple
  fetches.
- **Batched migration job** ([enrichment/migration-job.ts](src/enrichment/migration-job.ts))
  — thin wrapper over the existing enrichment worker (the
  `WHERE schema_version < CURRENT` mechanism already existed since Phase 4).
  `runMigration` drives re-enrichment in observable, resumable, transactional
  batches with progress callbacks. A bump of `ENRICHMENT_SCHEMA_VERSION` + this
  job = the full schema-migration story.
- **Descriptor validator** ([descriptor-validator.ts](src/descriptor-validator.ts)
  + CLI [scripts/validate-descriptor.ts](scripts/validate-descriptor.ts), `npm
  run validate-descriptor`) — dry-scrapes a page, reports per-selector health;
  a broken REQUIRED selector (jobList/jobLink/title) → `ok:false` → CLI exit 1
  (a CI gate for descriptor edits). Optional selectors (salary/postedAt) → warn.
- **Churn stress suite** ([churn-stress.test.ts](src/__tests__/churn-stress.test.ts))
  — formalizes the 50-node/30-min soak. **Opt-in** (skipped unless `CHURN_STRESS`
  is set; `=full` → 50 nodes/30 min, `=1` → 12 nodes/60s). The every-run
  correctness gate stays in [churn.test.ts](src/__tests__/churn.test.ts).

**Browser-dependent tests skip gracefully.** [extractor.test.ts](src/__tests__/extractor.test.ts)
probes `browserAvailable()` ([helpers/browser.ts](src/__tests__/helpers/browser.ts))
and skips if Chromium can't launch (e.g. bare WSL without Playwright's system
libs — run `npx playwright install-deps chromium`, needs root). The live
stealth bot-detection check is gated behind `RUN_STEALTH=1`. So a default
`npm test` is green everywhere; the browser/stealth paths are exercised where
the environment supports them. The extractor/validator LOGIC is typecheck-
verified regardless.

## Phase 8 quality gates

[migration-job.test.ts](src/__tests__/migration-job.test.ts): 1000 records at
v1, bump to v2, all migrate with no corruption; resumable; no-op when nothing
stale. [stealth-fetcher.test.ts](src/__tests__/stealth-fetcher.test.ts): jitter
bounds, proxy round-robin (+ gated live webdriver-masking check).
[extractor.test.ts](src/__tests__/extractor.test.ts) (browser-gated): selector
extraction + content-hash stamping; validator reports BROKEN on a broken
required selector, WARN on a missing optional one.

---

## Conventions

- Match surrounding code: 2-space indent, no semicolons, single quotes, explicit
  return types on exported functions, comment the *why* not the *what*.
- `.gitignore` already excludes `node_modules/`, `.claude/`, `*.db*`, and
  `data/skills-esco.json`. **`package-lock.json` IS committed** — it locks the
  v2 libp2p pins; don't remove it.
- Persistent project memory lives in `memory/` (indexed by `memory/MEMORY.md`).
  Check it for prior decisions before re-deriving them.
```
