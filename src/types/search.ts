export interface SearchMatch {
  path: string
  line: number
  content: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}

export type SearchBackend = 'rg' | 'grep' | 'findstr'
