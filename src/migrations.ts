import type Database from 'better-sqlite3'

/**
 * A single forward migration. `up` runs inside a transaction; it must be
 * idempotent-safe only insofar as it is gated by `user_version` (see below) —
 * each migration runs exactly once, in order, and never again.
 */
export interface Migration {
  /** 1-based, contiguous, strictly increasing. */
  version: number
  /** Human-readable description, for logging/debugging. */
  name: string
  up(db: Database.Database): void
}

/**
 * The ordered list of schema migrations for a node's local SQLite store.
 *
 * This is the DDL counterpart to the enrichment `schema_version` column: this
 * `user_version` tracks the *table shapes*, while the per-row `schema_version`
 * tracks which *extractor revision* last touched a job. They evolve
 * independently — adding a column is a migration here; changing a regex is a
 * bump of ENRICHMENT_SCHEMA_VERSION in types.ts.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial jobs + enrichments tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          content_hash TEXT PRIMARY KEY,
          platform_id  TEXT NOT NULL,
          url          TEXT NOT NULL,
          title        TEXT NOT NULL,
          company      TEXT NOT NULL,
          location     TEXT NOT NULL,
          description  TEXT NOT NULL,
          salary       TEXT,
          posted_at    TEXT,
          scraped_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scraped_at ON jobs (scraped_at);

        CREATE TABLE IF NOT EXISTS enrichments (
          content_hash    TEXT PRIMARY KEY
                            REFERENCES jobs (content_hash) ON DELETE CASCADE,
          salary_min      REAL,
          salary_max      REAL,
          salary_currency TEXT,
          salary_period   TEXT,
          salary_conf     REAL NOT NULL DEFAULT 0,
          yoe             INTEGER,
          yoe_conf        REAL NOT NULL DEFAULT 0,
          seniority       TEXT,
          seniority_conf  REAL NOT NULL DEFAULT 0,
          skills          TEXT NOT NULL DEFAULT '[]',
          schema_version  INTEGER NOT NULL,
          enriched_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_enrich_schema_version
          ON enrichments (schema_version);
      `)
    },
  },
]

/**
 * Runs every migration whose version exceeds the database's current
 * `PRAGMA user_version`, in order, each in its own transaction, then advances
 * `user_version`. Safe to call on every open: already-applied migrations are
 * skipped. Throws if the migration list is non-contiguous or the DB is ahead
 * of the code (a downgrade, which we refuse to guess at).
 */
export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const target = MIGRATIONS.length

  if (current > target) {
    throw new Error(
      `Database user_version ${current} is newer than the code (${target}). ` +
        `Refusing to downgrade.`,
    )
  }

  MIGRATIONS.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migration list is non-contiguous: index ${i} has version ${m.version}.`,
      )
    }
  })

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const run = db.transaction(() => {
      migration.up(db)
      // user_version doesn't accept bound params; it's an internal int we control.
      db.pragma(`user_version = ${migration.version}`)
    })
    run()
  }
}
