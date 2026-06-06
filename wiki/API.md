# Kalthraxius Aggregator Query API

The `aggregator-query` node exposes a local HTTP API over the SQLite store and
search index it maintains.  Any frontend can point at an aggregator's address
and query it directly — there is no SDK or authentication layer required.

---

## Running the server

```
node --experimental-strip-types src/bin/aggregator-query.ts
```

| Environment variable | Default         | Description                          |
|----------------------|-----------------|--------------------------------------|
| `KAL_QUERY_PORT`     | `3000`          | HTTP listen port                     |
| `KAL_QUERY_HOST`     | `127.0.0.1`     | Bind host. Use `0.0.0.0` for LAN/WAN |

All other variables (`KAL_LISTEN`, `KAL_BOOTSTRAP`, …) are the same as for the
plain aggregator — see [`example.env`](../example.env).

---

## Base URL

```
http://<host>:<port>
```

All endpoints return JSON.  The server sends CORS headers (`Access-Control-Allow-Origin: *`)
on every response, so frontends may be hosted on any origin.

---

## Endpoints

### `GET /stats`

Returns aggregated coverage statistics for the node.

**Response — `200 OK`**

```json
{
  "totalJobs": 1482,
  "byPlatform": {
    "linkedin": 740,
    "greenhouse": 512,
    "lever": 230
  },
  "salaryNullRate": 0.34,
  "newestScrapedAt": 1717703020000
}
```

| Field            | Type                       | Description                                             |
|------------------|----------------------------|---------------------------------------------------------|
| `totalJobs`      | `number`                   | Total distinct jobs held (deduplicated by content hash) |
| `byPlatform`     | `Record<string, number>`   | Job count per platform ID                               |
| `salaryNullRate` | `number` (0–1)             | Fraction of jobs where salary could not be extracted    |
| `newestScrapedAt`| `number` (Unix ms) \| `0` | Timestamp of the most recently ingested job             |

---

### `GET /jobs`

Returns all indexed jobs, ordered newest-scraped first.

**Query parameters**

| Parameter | Type   | Default | Max  | Description               |
|-----------|--------|---------|------|---------------------------|
| `limit`   | number | `100`   | `1000` | Maximum jobs to return  |

**Response — `200 OK`** — array of [`IndexedJob`](#indexedjob)

```json
[
  {
    "job": { ... },
    "enrichment": { ... }
  }
]
```

---

### `GET /jobs/:hash`

Returns a single job by its content hash.

**Path parameter**

| Parameter | Description                        |
|-----------|------------------------------------|
| `hash`    | The `contentHash` of the job (hex) |

**Response — `200 OK`** — single [`IndexedJob`](#indexedjob)

**Response — `404 Not Found`**

```json
{ "error": "not found" }
```

---

### `POST /search`

Full-text search over the local index.  Returns matching jobs with relevance
scores, each with the full job object attached.

**Request body** (`application/json`) — [`SearchQuery`](#searchquery)

```json
{
  "text": "backend engineer Go",
  "platformId": "greenhouse",
  "limit": 25
}
```

**Response — `200 OK`** — array of [`SearchHit`](#searchhit)

```json
[
  {
    "contentHash": "a3f9c1...",
    "score": 12.4,
    "indexed": {
      "job": { ... },
      "enrichment": { ... }
    }
  }
]
```

`indexed` is the full [`IndexedJob`](#indexedjob) for that hash.  It will be
`undefined` in the unlikely case a search index entry refers to a hash that was
evicted from the store — frontends should guard for this.

**Response — `400 Bad Request`**

```json
{ "error": "invalid search query" }
```

Returned when `text` is missing or the body is not valid JSON.

---

## Data types

### `IndexedJob`

```ts
{
  job:        RawJob
  enrichment: Enrichment
}
```

---

### `RawJob`

The raw scraped record exactly as the scraper captured it.

| Field          | Type              | Description                                       |
|----------------|-------------------|---------------------------------------------------|
| `contentHash`  | `string`          | SHA-256 hex of the normalised job fields (dedup key) |
| `platformId`   | `string`          | Source platform (e.g. `"linkedin"`, `"lever"`)    |
| `url`          | `string`          | Original job posting URL                          |
| `title`        | `string`          | Job title                                         |
| `company`      | `string`          | Hiring company name                               |
| `location`     | `string`          | Location string as scraped                        |
| `description`  | `string`          | Full job description — may contain HTML markup    |
| `salary`       | `string \| null`  | Raw salary text as scraped, or `null`             |
| `postedAt`     | `string \| null`  | Raw posted-date string as scraped, or `null`      |
| `scrapedAt`    | `number`          | Unix ms timestamp of when the job was scraped     |

> **Note on `description`:** The field contains the raw HTML from the source
> page.  Frontends should render it in a sandboxed context (e.g. a sandboxed
> `<iframe>`) rather than injecting it directly into the DOM.

---

### `Enrichment`

Structured fields extracted from the raw job by the enrichment pipeline.

| Field           | Type                                     | Description                                      |
|-----------------|------------------------------------------|--------------------------------------------------|
| `contentHash`   | `string`                                 | Foreign key to the parent `RawJob`               |
| `salary`        | `EnrichedField<SalaryExtraction \| null>`| Structured salary data                           |
| `yoe`           | `EnrichedField<number \| null>`          | Years-of-experience requirement                  |
| `seniority`     | `EnrichedField<SeniorityLevel \| null>`  | Classified seniority tier                        |
| `skills`        | `SkillMatch[]`                           | Matched skills with confidence scores            |
| `schemaVersion` | `number`                                 | Enrichment schema version (internal)             |
| `enrichedAt`    | `number`                                 | Unix ms timestamp of last enrichment             |

#### `EnrichedField<T>`

```ts
{ value: T, confidence: number }
```

`confidence` is `0` when `value` is `null`, otherwise in the range `(0, 1]`.
A low confidence value means the extraction was uncertain.

#### `SeniorityLevel`

One of:

```
"intern" | "junior" | "mid" | "senior" | "staff" |
"principal" | "lead" | "manager" | "director" | "executive"
```

#### `SalaryExtraction`

```ts
{
  min:      number | null   // lower bound of the salary range
  max:      number | null   // upper bound
  currency: string | null   // ISO 4217 code, e.g. "USD"
  period:   "year" | "month" | "week" | "day" | "hour" | null
}
```

Both `min` and `max` may be `null` if only one bound was found.

#### `SkillMatch`

```ts
{
  id:         string   // canonical skill identifier
  label:      string   // human-readable label, e.g. "TypeScript"
  confidence: number   // (0, 1]
}
```

---

### `SearchQuery`

| Field        | Type     | Required | Description                              |
|--------------|----------|----------|------------------------------------------|
| `text`       | `string` | Yes      | Free-text query (title / company / description) |
| `platformId` | `string` | No       | Filter results to a single platform      |
| `limit`      | `number` | No       | Maximum hits to return (server default: 10) |

---

### `SearchHit`

| Field         | Type                        | Description                              |
|---------------|-----------------------------|------------------------------------------|
| `contentHash` | `string`                    | Hash of the matching job                 |
| `score`       | `number`                    | FTS relevance score (higher = more relevant) |
| `indexed`     | `IndexedJob \| undefined`   | Full job + enrichment for this hash      |

---

## Error responses

All error responses share the same envelope:

```json
{ "error": "<message>" }
```

| Status | Meaning                                           |
|--------|---------------------------------------------------|
| `400`  | Malformed request body                            |
| `404`  | Resource not found                                |
| `500`  | Internal server error (check aggregator logs)     |

---

## CORS

The server sends the following headers on every response, including preflight
`OPTIONS` requests:

```
Access-Control-Allow-Origin:  *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: content-type
```

Frontends hosted on any origin (including `file://`) can call the API without
proxy or configuration.

---

## Pagination

`GET /jobs` accepts a `limit` parameter (max `1000`) but does not currently
support cursor- or offset-based pagination.  For large datasets, use
`POST /search` with a specific query to narrow results, or increase `limit`
up to the cap and filter client-side.
