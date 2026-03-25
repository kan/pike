export interface SearchMatch {
  path: string
  line: number
  content: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}

// "rg" = system rg, "rg:/path/to/rg.exe" = bundled sidecar, "grep" = fallback
export type SearchBackend = string
