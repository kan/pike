export interface SearchMatch {
  path: string
  line: number
  content: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}

export type SearchBackendKind = 'rg' | 'grep'

/**
 * バックエンドと、そこで使える機能（#304）。
 *
 * **版ではなく機能で受け取る。** Windows は同梱の rg だが WSL は distro のものなので、
 * 14 系や pcre2 無しのビルドが普通にありうる。`major >= 15` の判定は Rust 側に置いてある
 * （フロントにも書くと同じ知識が 2 箇所に散る）。
 */
export interface SearchBackendInfo {
  backend: SearchBackendKind
  version: string | null
  /** `-P/--pcre2`（先読み・後方参照）のトグルを出してよいか。 */
  pcre2: boolean
}

/** 検索の指定。Rust の `SearchOptions` と同じ形（camelCase で渡る）。 */
export interface SearchOptions {
  query: string
  isRegex?: boolean
  /** 既定は「区別しない」。`Aa` を押したときだけ true。 */
  caseSensitive?: boolean
  wholeWord?: boolean
  usePcre2?: boolean
  globInclude?: string | null
  globExclude?: string | null
}
