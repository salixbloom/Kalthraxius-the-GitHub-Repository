import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { PlatformDescriptor } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('platform descriptor schema', () => {
  it('greenhouse-example.json has all required fields', () => {
    const raw = readFileSync(
      join(__dirname, '../../src/descriptors/greenhouse-example.json'),
      'utf8',
    )
    const desc = JSON.parse(raw) as PlatformDescriptor

    expect(desc.id).toBeTruthy()
    expect(desc.name).toBeTruthy()
    expect(desc.baseUrl).toMatch(/^https?:\/\//)
    expect(['http', 'browser']).toContain(desc.fetcherMode)
    expect(desc.rateLimit.requestsPerMinute).toBeGreaterThan(0)
    expect(desc.pagination.maxPages).toBeGreaterThan(0)
    expect(desc.selectors?.jobList).toBeTruthy()
    expect(desc.selectors?.title).toBeTruthy()
  })
})
