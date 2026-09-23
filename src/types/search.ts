export interface SearchMatch {
  path: string
  line: number
  content: string
  /** 置換を頼んだ検索のときだけ（#401）。Rust の `LineReplace`。 */
  replace?: LineReplace
}

/**
 * 1 行ぶんの置換（#401）。**置換後の行は rg が組む**（`$1` の展開を JS の正規表現で
 * 真似ると、プレビューと実際の一致がずれる）。
 */
export interface LineReplace {
  /** `content` の中の一致の位置（UTF-16。`String.prototype.slice` にそのまま使える）。 */
  spans: { start: number; end: number; text: string }[]
  /** 置換後の行（改行を含まない）。 */
  line: string
}

/** `search_replace_apply` に渡す 1 ファイルぶん。`from` は検索したときの `content`。 */
export interface ReplaceFileEdit {
  path: string
  lines: { line: number; from: string; to: string }[]
}

export type ReplaceFailReason = 'missing' | 'tooLarge' | 'notUtf8' | 'io'

export interface ReplaceOutcome {
  files: number
  lines: number
  /** 検索のあとに中身が変わっていて書かなかった行。 */
  stale: number
  failed: { path: string; reason: ReplaceFailReason; detail: string | null }[]
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
  /** 置換（#401）を出してよいか。rg なら版を問わず true、grep では false。 */
  replace: boolean
  /**
   * rg だが更新を勧めるほど古い（13 以前。判定は Rust の `RgCaps::outdated`）。
   * `outdated` と `rgMissing` は**事実だけ**で、勧めるのは WSL だけという方針は
   * `stores/search.ts` の `ripgrepNotice` が持つ。
   */
  outdated: boolean
  /** rg が**確かに**無い（時間切れで grep に落ちたのではない）。導入を勧めるのはこのときだけ。 */
  rgMissing: boolean
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
  /** 結果をタブに書き出すための検索（#376）。パネルより上限が広い（Rust 側の doc）。 */
  extract?: boolean
  /**
   * 置換後の文字列（#401）。**空文字も置換**（一致を消す）なので、置換しないときは
   * null / 省略にする。正規表現のときは `$1` を展開し、そうでなければ字面のまま。
   */
  replacement?: string | null
}
