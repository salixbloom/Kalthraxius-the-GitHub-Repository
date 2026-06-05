import { mkdirSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Scoped file + stdout logger.
 *
 * Each scope maps to a dedicated log file AND mirrors to stdout. A combined
 * log receives every message regardless of scope. Log files sit in logs/ at
 * the project root and are created on first write.
 *
 * Scopes → files:
 *   node, p2p, dht   → logs/p2p.log
 *   scraper, scrape  → logs/scraper.log
 *   aggregator       → logs/aggregator.log
 *   identity,
 *   shutdown, error  → logs/system.log
 *   <all>            → logs/combined.log
 *
 * Levels: debug < info < warn < error
 * Set LOG_LEVEL env var to filter (default: info).
 * Set LOG_DIR env var to override the log directory.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogScope =
  | 'node' | 'p2p' | 'dht'
  | 'scraper' | 'scrape'
  | 'aggregator'
  | 'identity' | 'shutdown' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const SCOPE_FILE: Record<LogScope, string> = {
  node: 'p2p.log', p2p: 'p2p.log', dht: 'p2p.log',
  scraper: 'scraper.log', scrape: 'scraper.log',
  aggregator: 'aggregator.log',
  identity: 'system.log', shutdown: 'system.log', error: 'system.log',
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: 'DBG',
  info:  'INF',
  warn:  'WRN',
  error: 'ERR',
}

// Resolve logs/ relative to the project root (two levels up from src/logger.ts → dist/logger.js)
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = process.env['LOG_DIR'] ?? join(__dirname, '..', 'logs')
const MIN_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info'

let dirCreated = false
function ensureLogDir(): void {
  if (dirCreated) return
  mkdirSync(LOG_DIR, { recursive: true })
  dirCreated = true
}

// Lazily opened write streams — one per target file
const streams = new Map<string, ReturnType<typeof createWriteStream>>()

function getStream(filename: string): ReturnType<typeof createWriteStream> {
  let s = streams.get(filename)
  if (!s) {
    ensureLogDir()
    s = createWriteStream(join(LOG_DIR, filename), { flags: 'a', encoding: 'utf8' })
    streams.set(filename, s)
  }
  return s
}

function formatLine(level: LogLevel, scope: LogScope, message: string): string {
  const ts = new Date().toISOString()
  return `${ts} [${LEVEL_PREFIX[level]}] [${scope}] ${message}\n`
}

function write(level: LogLevel, scope: LogScope, message: string): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return

  const line = formatLine(level, scope, message)

  // Scope-specific file
  getStream(SCOPE_FILE[scope]).write(line)

  // Combined log
  if (SCOPE_FILE[scope] !== 'combined.log') {
    getStream('combined.log').write(line)
  }

  // Stdout/stderr mirror
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line)
  } else {
    process.stdout.write(line)
  }
}

/** Flush all open log streams. Call before process exit for clean shutdown. */
export async function flushLogs(): Promise<void> {
  await Promise.all(
    [...streams.values()].map(
      s => new Promise<void>(resolve => s.end(resolve)),
    ),
  )
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Create a logger bound to a specific scope. */
export function createLogger(scope: LogScope): Logger {
  return {
    debug: (msg) => write('debug', scope, msg),
    info:  (msg) => write('info',  scope, msg),
    warn:  (msg) => write('warn',  scope, msg),
    error: (msg) => write('error', scope, msg),
  }
}

// Pre-built loggers for each scope — import these directly
export const log = {
  node:        createLogger('node'),
  p2p:         createLogger('p2p'),
  dht:         createLogger('dht'),
  scraper:     createLogger('scraper'),
  scrape:      createLogger('scrape'),
  aggregator:  createLogger('aggregator'),
  identity:    createLogger('identity'),
  shutdown:    createLogger('shutdown'),
  error:       createLogger('error'),
}
