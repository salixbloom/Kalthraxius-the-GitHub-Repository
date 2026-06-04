import type { PlatformDescriptor } from './types.js'

/**
 * Pagination URL computation for the `page` and `offset` types (PLAN.md
 * descriptor `pagination`). `cursor` pagination is NOT computed here — its next
 * URL is read from page HTML (see the extractor's `extractNextLink`), so it has
 * no counter-based formula.
 *
 * Pure and synchronous: given the base URL and a 0-based page index, produce the
 * URL for that page. The scrape loop walks indices 0..maxPages-1 (or follows
 * cursors) and stops early on an empty page.
 */

/**
 * URL for the Nth page (0-based) of a `page`/`offset` paginated board.
 *
 *   - `page`   → pageParam = pageIndex + 1   (1-based page numbers)
 *   - `offset` → pageParam = pageIndex * pageSize  (row offset)
 *
 * Page 0 returns the base URL UNMODIFIED, so a board that's happy with its bare
 * base URL for the first page isn't given a spurious `?page=1`/`?page=0`. For
 * `cursor`, this only ever returns the base URL (page 0); later pages come from
 * the extracted next link.
 */
export function pageUrl(baseUrl: string, pagination: PlatformDescriptor['pagination'], pageIndex: number): string {
  if (pageIndex === 0) return baseUrl
  if (pagination.type === 'cursor') return baseUrl

  const url = new URL(baseUrl)
  const value =
    pagination.type === 'offset' ? pageIndex * pagination.pageSize : pageIndex + 1
  url.searchParams.set(pagination.pageParam, String(value))
  return url.toString()
}

/** True if pagination is switched on for this descriptor. */
export function paginationEnabled(descriptor: PlatformDescriptor): boolean {
  return descriptor.pagination.enabled === true
}

/**
 * The hard ceiling on pages to fetch in one pass. Always ≥ 1 (we always fetch at
 * least the base page). When pagination is off, it's exactly 1.
 */
export function maxPagesFor(descriptor: PlatformDescriptor): number {
  if (!paginationEnabled(descriptor)) return 1
  return Math.max(1, descriptor.pagination.maxPages)
}
