# Kalthraxius — Implementation Plan

## What We're Building

A qualification-first job search engine. Scraping is distributed across many cheap nodes to spread IP footprint and parallelise crawling. A small federated layer of aggregator nodes indexes everything and serves structured queries. Users query aggregators and get back only jobs they actually qualify for.

---

## Settled Decisions

| Concern | Decision |
|---|---|
| Runtime | Node.js (TypeScript) |
| P2P transport | libp2p — Kademlia DHT + GossipSub |
| Gossip topics | Per-platform (`jobs/greenhouse/v1`, `jobs/linkedin/v1`, etc.) |
| Node security | Noise protocol + Ed25519 identity |
| Fetcher | undici (HTTP-first), Playwright/Chromium fallback |
| Aggregator DB | PostgreSQL + MeiliSearch |
| Enrichment | Classical NLP only — regex, rule-based, curated taxonomy. No LLM. |
| Aggregator model | Model A — curated set, DHT discovery as path to open federation |
| Schema versioning | `schema_version INTEGER` + `enriched_at TIMESTAMP`. Enrichment queue = migration mechanism. |
| Storage per node | 1–5GB rolling cache, 30–90 day TTL eviction |
| Query model | Hard filter → score (stack overlap) → rank (freshness) |
| Consumer API | REST + SSE streaming, fan-out K=6 peers, dedup by content hash |

---

## Architecture Layers

| Layer | Role | Technology |
|---|---|---|
| Scraper nodes | Fetch raw job postings, coordinate via DHT | Node.js + undici / Playwright |
| Coordination | Peer discovery, scrape-claim records, job gossip | libp2p Kademlia DHT + GossipSub |
| Transport security | Encrypted, mutually-authenticated channels | Noise protocol + Ed25519 |
| Aggregator nodes | Index, enrich, serve queries | PostgreSQL + MeiliSearch + classical NLP |
| Consumer layer | Query interface | REST / SSE |

---

## Trust & Reputation System

- **Content-hash integrity** — SHA-256 hash verification against any peer holding the raw payload. Detects fabricated data.
- **Cross-aggregator consistency** — compare self-reported stats (coverage, null rates) visible in DHT announcements.
- **Async staleness probe** — aggregator periodically re-fetches N random old job URLs and reports staleness rate.
- **User feedback gossip** — lightweight `{ jobId, reason }` signals gossip through the network and accumulate per-aggregator.
- **Client reputation score** — weighted combination of stats + local feedback accumulation. Clients prefer high-scoring aggregators.

---

## Phases

### Phase 0 — Project Scaffold
- Monorepo structure, TypeScript config, test framework (vitest)
- Local multi-node test harness — spin up N isolated libp2p nodes in a single process

**Verification:**
- CI passes on empty test suite
- Harness launches 5 nodes, they discover each other, tear down cleanly

---

### Phase 1 — Scraper Core (No Networking)
- Platform descriptor schema (JSON config per job board: selectors, pagination, rate limit, fetcher mode)
- Two-tier fetcher: undici HTTP-first, Playwright/Chromium fallback
- SHA-256 content hashing on raw payloads
- SQLite local cache with configurable size cap and TTL-based eviction (oldest-first)

**Verification:**
- Scrape a real target, produce a job record
- Same target scraped twice — hashes match, second write is a no-op
- Cache filled past cap — oldest entries evict, newer survive
- Swap descriptor from Playwright to HTTP — fetcher switches without code changes

---

### Phase 2 — libp2p Foundation
- Ed25519 node identity generation and persistence
- Noise protocol handshake
- Basic peer connectivity (ping)

**Verification:**
- Two nodes connect and complete Noise handshake
- Traffic is encrypted (no plaintext job data on wire)
- Node that restarts keeps same identity, is recognized by peers
- Node with tampered key is rejected

---

### Phase 3 — DHT + GossipSub + Coordination
- Kademlia DHT for peer discovery and scrape-claim records
- GossipSub with per-platform topics
- Bootstrap node (plain libp2p node, known multiaddr)
- Circuit relay v2 on bootstrap node for NAT traversal
- Scrape-claim write/read in DHT (TTL=30min)

**HARD GATE — DHT churn test must pass before Phase 4 begins.**

**Verification:**
- 3-node harness: A claims target, B and C skip it
- Kill A mid-claim — B claims after TTL expiry
- Gossip propagates to all subscribers within expected time
- 10 nodes, 5 minutes of random join/leave — DHT stays functional

---

### Phase 4 — Enrichment Pipeline
Async, decoupled from ingest. Store raw immediately, enrich behind.

Enrichment stack (CPU-only, no ML dependency):
- **Salary:** regex (~95% format coverage). Unknown → `null`.
- **YOE:** regex. Ambiguous → `null`.
- **Seniority:** rule-based title keyword matching (primary) + description patterns (secondary).
- **Skills:** curated taxonomy + fuzzy matching. Seeded from ESCO skills dataset.
- All fields carry per-field confidence scores.

Schema: `schema_version INTEGER`, `enriched_at TIMESTAMP`. Enrichment queue doubles as migration mechanism (`WHERE schema_version < CURRENT`).

**Verification:**
- 50 real job postings across 3+ platforms. Check null rates and obvious extraction errors.
- Salary null rate <10% on postings that visibly contain a salary range
- Seniority accuracy >90% on postings with explicit title signal
- Skills recall >80% on explicit bullet-pointed skills sections
- Enrichment throughput: 1000 jobs/min on single core without blocking ingest
- Re-enrichment: bump schema version, re-queue all records, confirm no corruption

---

### Phase 5 — Aggregator Node
- PostgreSQL + MeiliSearch on a persistent node
- Subscribe to all per-platform GossipSub topics
- DHT announcement with peer type `role:aggregator` and self-reported stats
- Bloom filter gossip (periodic broadcast of content hash set)

**Verification:**
- Aggregator + 3 scrapers: all gossiped jobs appear indexed in MeiliSearch
- Aggregator restart — reconnects to gossip, no data loss
- DHT announcement stats match actual database state

---

### Phase 6 — Query Layer
- User profile: `{ stack: string[], yoe: number, location: string | "remote", salaryFloor: number }`
- Query execution: hard filter → score (stack overlap) → rank (freshness, 60+ day penalty)
- REST API + SSE streaming endpoint
- Fan-out to K=6 peers, dedup by content hash, merge into stream
- Client aggregator discovery via DHT (`role:aggregator` lookup), automatic failover

**Verification:**
- 5 known test profiles against seeded job DB — expected jobs returned, mismatches excluded
- Hard filter: 7 YOE job not returned for 3 YOE profile
- Ranking: 2-day posting outranks identical 90-day posting
- Fan-out dedup: same job seeded on 3 nodes returns exactly once
- First SSE results arrive <200ms
- Aggregator failover: primary dies mid-session, client switches automatically

---

### Phase 7 — Trust & Reputation
- Content-hash integrity verification on received jobs
- Cross-aggregator stat comparison from DHT announcements
- Async staleness probe (aggregator self-samples N old jobs, re-fetches URLs)
- User feedback gossip (`{ jobId, reason }` signals)
- Client-side reputation scoring (weighted stats + feedback)

**Verification:**
- Manually corrupt a job record — hash mismatch detected and flagged
- Seed 100 jobs, mark 30 URLs dead — staleness probe reports ~30%
- Feedback signal from one client appears in aggregator logs within 2 gossip cycles
- Aggregator with broken salary regex — client reputation score degrades vs healthy aggregator

---

### Phase 8 — Hardening (Ongoing)
- `playwright-extra` stealth plugin, timing jitter, proxy rotation adapter in fetcher
- Schema migration background job (`WHERE schema_version < CURRENT`, batched)
- Platform descriptor validator CLI (dry scrape, report extraction results)
- Formalized DHT churn stress suite (50 nodes, 30 min randomized churn)

**Verification:**
- Stealth scraper passes a bot-detection test page
- Migration: 1000 records at v0, bump version, all reach current with no corruption
- Descriptor CLI reports correct failure on a broken selector

---

## Risk Register

| Risk | Phase | Signal to watch |
|---|---|---|
| Bot detection breaking scrapers | 1, 8, ongoing | Per-platform scrape success rate. <80% = investigate immediately. |
| Enrichment null rates | 4+ | Instrument from day one. Salary null >30% on any platform = regex needs work. |
| DHT churn instability | 3 | Hard gate — churn test must pass before Phase 4. |
| Fan-out SSE latency | 6 | First results must arrive <200ms. Reduce K or make fan-out fully async if bottlenecked. |
| Aggregator Sybil manipulation | 7 | Content-hash verification is the only tamper-proof signal. Weight it highest in reputation score. |
