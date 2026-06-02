# AGENT_README — context for future agents

Read this before touching the codebase. It captures the non-obvious decisions
and traps that aren't visible from the code or git history. For *what* we're
building and the phase roadmap, see [PLAN.md](PLAN.md).

Kalthraxius is a decentralized, qualification-first job search network: many
cheap scraper nodes coordinate over libp2p; aggregator nodes index and serve
queries; users get back only jobs they qualify for. Node.js + TypeScript.

**Phase status:** Phases 1–3 (scraper core, libp2p identity, DHT + GossipSub +
coordination) and Phase 4 (enrichment pipeline) are built and green. Next up is
Phase 5 (aggregator node). The Phase 3 DHT churn test is a HARD GATE and passes.

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

## Conventions

- Match surrounding code: 2-space indent, no semicolons, single quotes, explicit
  return types on exported functions, comment the *why* not the *what*.
- `.gitignore` already excludes `node_modules/`, `.claude/`, `*.db*`, and
  `data/skills-esco.json`. **`package-lock.json` IS committed** — it locks the
  v2 libp2p pins; don't remove it.
- Persistent project memory lives in `memory/` (indexed by `memory/MEMORY.md`).
  Check it for prior decisions before re-deriving them.
```
