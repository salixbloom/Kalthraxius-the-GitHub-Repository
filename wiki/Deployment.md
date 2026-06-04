# Deployment

How to run Kalthraxius nodes across popular deployment targets:
[bare-metal / systemd](#bare-metal--systemd), [Docker](#docker),
[Docker Compose](#docker-compose), and [Kubernetes](#kubernetes).

> The repo does **not** ship a Dockerfile or k8s manifests. The ones below are
> reference templates — copy them into your deployment repo (or the project
> root) and adjust. Everything else (entrypoints, env vars, npm scripts) is real
> and already in the codebase.

---

## Contents

- [Before you deploy](#before-you-deploy)
  - [Run model](#run-model)
  - [Roles & entrypoints](#roles--entrypoints)
  - [Configuration (environment variables)](#configuration-environment-variables)
  - [Persistent state](#persistent-state)
  - [Networking & ports (read this for P2P)](#networking--ports-read-this-for-p2p)
- [Bare-metal / systemd](#bare-metal--systemd)
- [Docker](#docker)
- [Docker Compose](#docker-compose)
- [Kubernetes](#kubernetes)
- [Operational notes](#operational-notes)

---

## Before you deploy

### Run model

Kalthraxius is TypeScript + native-ESM. It **compiles to `dist/` and runs from
there** — the entrypoints are not meant to run from `.ts` source via
`--experimental-strip-types` (the codebase uses `.js` import specifiers
throughout, which Node's type-stripper does not remap). Every deployment is some
flavour of:

```bash
npm ci            # install exact, locked deps (do NOT use `npm install` in prod)
npm run build     # tsc → dist/
node dist/bin/<role>.js
```

- **Node.js ≥ 20** (developed/tested on Node 24). There is no `engines` field;
  pin the version yourself in your base image / host.
- **`npm ci` against the committed `package-lock.json` is mandatory.** The lockfile
  pins the deliberately-chosen libp2p **v2** stack and the `inflight`-removal
  overrides. A fresh `npm install` can drift the tree and break P2P. Never run
  `npm audit fix --force` (it pulls libp2p v3 and shatters the stack — see
  [AGENT_README](../AGENT_README.md)).

### Roles & entrypoints

| Role | Command (npm) | Command (direct) |
|---|---|---|
| Aggregator | `npm run start:aggregator` | `node dist/bin/aggregator.js` |
| Scraper | `npm run start:scraper` | `node dist/bin/scraper.js` |
| Aggregator-scraper | `npm run start:aggregator-scraper` | `node dist/bin/aggregator-scraper.js` |

All three respond to `SIGINT`/`SIGTERM` with a graceful shutdown (stop
subscriptions/timers, close the store, stop the node) — so they behave well
under `systemctl stop`, `docker stop`, and k8s pod termination.

### Configuration (environment variables)

All config is environment-driven. Defaults in parentheses.

**Common (all roles):**

| Var | Default | Notes |
|---|---|---|
| `KAL_LISTEN` | `/ip4/0.0.0.0/tcp/0` | libp2p listen multiaddr. **Set a fixed port** in production (e.g. `/ip4/0.0.0.0/tcp/4001`) so it's mappable/exposable. |
| `KAL_ANNOUNCE` | – | Comma-separated multiaddrs to advertise to peers. **Required behind NAT or Docker bridge networking.** Set to your public DNS/IP address so other nodes can dial back — e.g. `/dns4/jobs.example.com/tcp/4001/p2p/<peerId>`. Without this, the node advertises only its container/internal address and remote peers time out. |
| `KAL_BOOTSTRAP` | – | Comma-separated multiaddrs of known peers to dial on start. How a new node joins the network. |
| `KAL_IDENTITY_FILE` | `node.key` | Path to persist the Ed25519 key. **Put this on a persistent volume** so the node keeps its peer id across restarts. |
| `KAL_ALLOW_PRIVATE` | off | `1`/`true` keeps loopback/private addresses in the DHT routing table. Needed for single-host/local clusters; **leave off in production**. |

**Aggregator (`aggregator.js`, `aggregator-scraper.js`):**

| Var | Default | Notes |
|---|---|---|
| `KAL_STORE_DB` | `aggregator-store.db` | SQLite store path. Persistent volume. |
| `KAL_SEARCH_DB` | `aggregator-search.db` | SQLite FTS index path. Persistent volume. |
| `KAL_PLATFORMS` | `data/platforms.json` | Comma-separated platform ids to subscribe to; empty = the registry default. |
| `KAL_ANNOUNCE_MS` | `30000` | DHT announce + bloom broadcast cadence (ms). |

**Scraper (`scraper.js`, `aggregator-scraper.js`):**

| Var | Default | Notes |
|---|---|---|
| `KAL_DESCRIPTOR` | – (**required**) | Path to a platform descriptor JSON. |
| `KAL_SCRAPE_MS` | `300000` | Interval between scrape passes (ms). |
| `KAL_CLAIM_TTL_MS` | `1800000` | DHT scrape-claim TTL (ms). |
| `KAL_STEALTH` | off | `1` uses the hardened stealth fetcher (needs Chromium). |
| `KAL_ONCE` | off | `1` runs a single pass and exits (cron/Job-friendly). |

### Persistent state

A node has up to three pieces of state that must survive restarts:

1. **Identity** (`KAL_IDENTITY_FILE`) — losing it changes the peer id.
2. **Store DB** (`KAL_STORE_DB`) — the aggregator's indexed jobs.
3. **Search DB** (`KAL_SEARCH_DB`) — the FTS index (rebuildable, but persist it
   to avoid a cold start).

Point these at a mounted volume / PVC. The aggregator recovers all jobs on
restart from the same files (no data loss).

### Networking & ports (read this for P2P)

libp2p peers must be able to **dial each other**. Two things matter:

- **Listen port.** Set `KAL_LISTEN=/ip4/0.0.0.0/tcp/4001` and expose/map that TCP
  port. The transport is TCP + Noise (encrypted, Ed25519-authenticated).
- **Announced address.** A node advertises the addresses it listens on. Behind
  NAT or container/pod networking, the address it *listens* on (`172.x.x.x`,
  `127.0.0.1`) is not the address peers can *reach*. Set `KAL_ANNOUNCE` to
  your public multiaddr so peers know where to dial:
  ```
  KAL_ANNOUNCE=/dns4/jobs.example.com/tcp/4001/p2p/<peerId>
  ```
  Without this, remote peers will time out even when the port is forwarded.
  Circuit-relay is not yet wired up — `KAL_ANNOUNCE` is the supported
  NAT-traversal mechanism today.

A practical bootstrap topology: run one well-known node with a fixed,
routable address and port, and point every other node's `KAL_BOOTSTRAP` at it.

---

## Bare-metal / systemd

Build once, then run each role as a systemd service.

```bash
# as the deploy user, in the project dir
npm ci
npm run build
mkdir -p /var/lib/kalthraxius      # persistent state dir
```

**Env file** `/etc/kalthraxius/aggregator.env`:

```ini
KAL_LISTEN=/ip4/0.0.0.0/tcp/4001
KAL_IDENTITY_FILE=/var/lib/kalthraxius/aggregator.key
KAL_STORE_DB=/var/lib/kalthraxius/store.db
KAL_SEARCH_DB=/var/lib/kalthraxius/search.db
KAL_BOOTSTRAP=/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...bootstrapPeerId
```

**Unit** `/etc/systemd/system/kalthraxius-aggregator.service`:

```ini
[Unit]
Description=Kalthraxius Aggregator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kalthraxius
WorkingDirectory=/opt/kalthraxius
EnvironmentFile=/etc/kalthraxius/aggregator.env
ExecStart=/usr/bin/node dist/bin/aggregator.js
Restart=on-failure
RestartSec=5
# graceful shutdown on stop
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kalthraxius-aggregator
journalctl -u kalthraxius-aggregator -f
```

A **scraper** unit is the same with `ExecStart=/usr/bin/node dist/bin/scraper.js`
and `KAL_DESCRIPTOR=/opt/kalthraxius/descriptors/greenhouse.json` in its env
file. For a one-shot scraper (cron instead of a long-running service), set
`KAL_ONCE=1` and drive it from a `systemd` timer or crontab.

---

## Docker

No Dockerfile ships with the repo. Reference multi-stage Dockerfile (Debian-slim
base — easier native-module builds than Alpine; **no Chromium**, so browser-mode
scraping and the descriptor validator are unavailable in this image):

```dockerfile
# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# only production deps (still need a compiler for better-sqlite3 rebuild on ci)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
COPY --from=build /app/src/descriptors ./src/descriptors
# default role; override with `docker run ... node dist/bin/<role>.js`
CMD ["node", "dist/bin/aggregator.js"]
```

`.dockerignore` (so the build context stays small and the host `node_modules`
never leaks in — it would break the native module ABI):

```
node_modules
dist
.git
*.db
*.db-shm
*.db-wal
.claude
```

Build and run an aggregator with a fixed port and a persistent volume:

```bash
docker build -t kalthraxius .

docker run -d --name kal-aggregator \
  -p 4001:4001 \
  -v kal-agg-data:/data \
  -e KAL_LISTEN=/ip4/0.0.0.0/tcp/4001 \
  -e KAL_IDENTITY_FILE=/data/node.key \
  -e KAL_STORE_DB=/data/store.db \
  -e KAL_SEARCH_DB=/data/search.db \
  -e KAL_BOOTSTRAP=/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...peerId \
  kalthraxius
```

A scraper overrides the command and sets the descriptor (mount it in):

```bash
docker run -d --name kal-scraper \
  -v kal-scr-data:/data \
  -v "$PWD/descriptors:/descriptors:ro" \
  -e KAL_IDENTITY_FILE=/data/node.key \
  -e KAL_DESCRIPTOR=/descriptors/greenhouse.json \
  -e KAL_BOOTSTRAP=/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...peerId \
  kalthraxius node dist/bin/scraper.js
```

> **Browser-mode scraping in Docker:** the slim image has no Chromium. If you
> need `KAL_STEALTH=1` or `fetcherMode: "browser"` descriptors, base the image on
> `mcr.microsoft.com/playwright:v1-jammy` (or add `npx playwright install
> --with-deps chromium` in the build stage). Much larger image. Most
> deployments only need it on dedicated scraper nodes — consider a separate
> `Dockerfile.browser` for those.

> **P2P reachability:** publish `-p 4001:4001` and set `KAL_ANNOUNCE` to the
> host's public multiaddr (e.g. `-e KAL_ANNOUNCE=/dns4/jobs.example.com/tcp/4001/p2p/<peerId>`).
> Without `KAL_ANNOUNCE` the node tells peers its container-internal address and
> they time out. See [Networking](#networking--ports-read-this-for-p2p).

---

## Docker Compose

A local cluster: one **bootstrap/aggregator**, two **scrapers**, on a shared
network. This is the containerized version of the multi-node quick-start.

```yaml
# docker-compose.yml
services:
  aggregator:
    build: .
    command: node dist/bin/aggregator.js
    environment:
      KAL_LISTEN: /ip4/0.0.0.0/tcp/4001
      KAL_IDENTITY_FILE: /data/node.key
      KAL_STORE_DB: /data/store.db
      KAL_SEARCH_DB: /data/search.db
      KAL_ANNOUNCE_MS: "15000"
      # single shared bridge network → the service name resolves and the
      # listen address is reachable by peers on the same network.
      KAL_ALLOW_PRIVATE: "1"
    volumes:
      - agg-data:/data
    ports:
      - "4001:4001"     # expose for an external client/gateway if you want

  scraper-greenhouse:
    build: .
    command: node dist/bin/scraper.js
    depends_on: [aggregator]
    environment:
      KAL_IDENTITY_FILE: /data/node.key
      KAL_DESCRIPTOR: /descriptors/greenhouse.json
      KAL_SCRAPE_MS: "120000"
      KAL_ALLOW_PRIVATE: "1"
      # dial the aggregator by service name; supply its peer id once known.
      KAL_BOOTSTRAP: /dns4/aggregator/tcp/4001/p2p/12D3KooW...aggregatorPeerId
    volumes:
      - scr-gh-data:/data
      - ./descriptors:/descriptors:ro

  scraper-lever:
    build: .
    command: node dist/bin/scraper.js
    depends_on: [aggregator]
    environment:
      KAL_IDENTITY_FILE: /data/node.key
      KAL_DESCRIPTOR: /descriptors/lever.json
      KAL_SCRAPE_MS: "120000"
      KAL_ALLOW_PRIVATE: "1"
      KAL_BOOTSTRAP: /dns4/aggregator/tcp/4001/p2p/12D3KooW...aggregatorPeerId
    volumes:
      - scr-lv-data:/data
      - ./descriptors:/descriptors:ro

volumes:
  agg-data:
  scr-gh-data:
  scr-lv-data:
```

```bash
docker compose up --build
```

**Bootstrapping note:** scrapers need the aggregator's **peer id** in
`KAL_BOOTSTRAP`. On first `up`, read it from the aggregator's logs
(`[node] peerId 12D3KooW…`) — its identity is persisted to the volume, so it's
stable across restarts. Put the id into the compose file (or an `.env`). On a
single shared bridge network the container's listen address is reachable, so
`/dns4/aggregator/tcp/4001/p2p/<id>` works; `KAL_ALLOW_PRIVATE=1` keeps those
private addresses in the routing table.

---

## Kubernetes

P2P nodes are **stateful** (stable identity + persistent store) and have
**reachability** requirements, so model each role as a **StatefulSet** with a
per-pod PersistentVolumeClaim. A `Deployment` is wrong here — pods would get
fresh identities and ephemeral storage.

```yaml
# aggregator-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kal-aggregator
spec:
  serviceName: kal-aggregator
  replicas: 1
  selector:
    matchLabels: { app: kal-aggregator }
  template:
    metadata:
      labels: { app: kal-aggregator }
    spec:
      # See the reachability note below — host networking is the simplest way
      # to make announced addresses routable today.
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: aggregator
          image: your-registry/kalthraxius:latest
          command: ["node", "dist/bin/aggregator.js"]
          env:
            - { name: KAL_LISTEN,       value: "/ip4/0.0.0.0/tcp/4001" }
            - { name: KAL_IDENTITY_FILE, value: "/data/node.key" }
            - { name: KAL_STORE_DB,     value: "/data/store.db" }
            - { name: KAL_SEARCH_DB,    value: "/data/search.db" }
            # - { name: KAL_BOOTSTRAP, value: "/ip4/.../tcp/4001/p2p/<id>" }
          ports:
            - { containerPort: 4001, name: libp2p }
          volumeMounts:
            - { name: data, mountPath: /data }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 5Gi } }
---
# headless service for stable DNS to the pod
apiVersion: v1
kind: Service
metadata:
  name: kal-aggregator
spec:
  clusterIP: None
  selector: { app: kal-aggregator }
  ports:
    - { port: 4001, targetPort: 4001, name: libp2p }
```

Scrapers are a similar StatefulSet with `command: ["node",
"dist/bin/scraper.js"]`, a `KAL_DESCRIPTOR` mounted from a ConfigMap, and
`KAL_BOOTSTRAP` pointing at the aggregator.

**Reachability on k8s.** Set `KAL_ANNOUNCE` to the pod's externally-reachable
multiaddr — either the node IP (with `hostNetwork: true`) or a `LoadBalancer`
service address. Without it the pod announces its cluster-internal pod IP which
off-cluster peers can't dial. `hostNetwork: true` is the simplest path if you
only need cluster-internal peers; for external peers set `KAL_ANNOUNCE` to a
`LoadBalancer` or `NodePort` address. Circuit-relay is not yet wired up.

**Descriptor via ConfigMap** (for scrapers):

```bash
kubectl create configmap kal-descriptors --from-file=descriptors/
# mount at /descriptors and set KAL_DESCRIPTOR=/descriptors/greenhouse.json
```

---

## Operational notes

- **Health/liveness:** there is no HTTP health endpoint on scraper/aggregator
  nodes. Use process liveness (systemd `Restart`, k8s default restart) plus the
  log heartbeat the aggregator prints each minute
  (`[aggregator] jobs=… rejected=… salaryNull=…%`). If you front it with a
  `QueryServer` (HTTP/SSE gateway), that process *does* listen on a port you can
  probe.
- **Logs:** plain stdout/stderr (`[node]`, `[aggregator]`, `[scraper]`,
  `[shutdown]` prefixes). Collect with your usual stack.
- **Scaling:** add more scrapers (each on its own descriptor/target) freely —
  DHT scrape-claims keep them from double-crawling. Aggregators can be scaled
  out too; clients fan out across them and dedup by content hash.
- **The query side** (`QueryClient`/`QueryServer`) isn't a packaged entrypoint.
  If you want an HTTP gateway as its own deployable, add a small entrypoint that
  constructs a node + `QueryServer` (see the [README](../README.md#http--sse-gateway))
  and run it the same way as the others.
- **Resource sizing:** the DHT/store run in-process; the default datastore is
  in-memory (RAM grows with held DHT records — the validator caps per-record
  size). Aggregator job data is on disk (SQLite). Browser-mode scraping needs
  meaningfully more memory (Chromium).
