# Kalthraxius Wiki

A decentralized, qualification-first job search network. Scraper nodes crawl
public job boards and coordinate over libp2p; aggregator nodes index + enrich
the data; clients query aggregators and get back only the jobs they qualify for.

This wiki organizes the operational and conceptual documentation. For the design
rationale see [PLAN.md](../PLAN.md); for usage/API see [README.md](../README.md);
for internal invariants and gotchas see [AGENT_README.md](../AGENT_README.md).

## Pages

- **[Deployment](Deployment.md)** — how to run the project: bare-metal/systemd,
  Docker, Docker Compose, and Kubernetes.

## Node roles at a glance

| Role | Entrypoint | What it does |
|---|---|---|
| Aggregator | `dist/bin/aggregator.js` | Subscribes to platform topics, verifies + enriches + indexes gossiped jobs, announces on the DHT, serves queries. Persistent (SQLite). |
| Scraper | `dist/bin/scraper.js` | Crawls a target on an interval, claims it in the DHT, extracts + gossips jobs. |
| Aggregator-scraper | `dist/bin/aggregator-scraper.js` | Both roles on one libp2p identity/node. |

A query **client** / HTTP-SSE **gateway** is a library API (`QueryClient`,
`QueryServer`) rather than a packaged entrypoint — see the
[README](../README.md#http--sse-gateway).

## Run model in one line

It's a TypeScript/ESM project that **compiles to `dist/` and runs from there**:

```bash
npm ci && npm run build && npm run start:aggregator
```

The [Deployment](Deployment.md) page expands this for each target.
