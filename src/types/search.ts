export interface SearchMatch {
  path: string
  line: number
  content: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}

export type SearchBackend =
  | { kind: 'rg' }
  | { kind: 'bundled-rg'; path: string }
  | { kind: 'grep' }

export function backendLabel(b: SearchBackend): string {
  return b.kind === 'grep' ? 'grep' : 'rg'
}
