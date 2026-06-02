export type FetcherMode = 'http' | 'browser'

export interface PlatformDescriptor {
  id: string
  name: string
  baseUrl: string
  fetcherMode: FetcherMode
  rateLimit: {
    requestsPerMinute: number
  }
  pagination: {
    type: 'offset' | 'cursor' | 'page'
    pageParam: string
    pageSize: number
    maxPages: number
  }
  selectors: {
    jobList: string
    jobLink: string
    title: string
    company: string
    location: string
    description: string
    salary?: string
    postedAt?: string
  }
}

export interface RawJob {
  contentHash: string
  platformId: string
  url: string
  title: string
  company: string
  location: string
  description: string
  salary: string | null
  postedAt: string | null
  scrapedAt: number
}
