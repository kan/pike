/**
 * 検索結果をファイルごとにまとめる（#440）。パネルの表示と「結果をタブで開く」の書き出し、
 * 書き出したタブからのジャンプが同じ形を共有する。
 *
 * **rg に頼むことは無い。** `--json` の出力は元からファイル単位（`begin` / `match` / `end`）で
 * 届き、grep の `-rn` も同じファイルの行を続けて出す。`--heading` はテキスト出力の整形で
 * `--json` には効かないので、まとめるのは受け取った側の仕事になる。並びも変えない
 * （`--sort path` は rg の並列走査を止める）。
 *
 * ストアにも codemirror にも触れない（Node のテストから確かめるため）。
 */

export interface FileGroup<M> {
  path: string
  matches: M[]
}

/**
 * 出てきた順を保ったまま、同じファイルの一致をまとめる。**隣り合っていることを当てに
 * しない**（置換で行を外したあとや、将来並びが変わっても同じファイルが 2 つに割れない）。
 */
export function groupByFile<M extends { path: string }>(matches: readonly M[]): FileGroup<M>[] {
  const groups = new Map<string, FileGroup<M>>()
  for (const m of matches) {
    const group = groups.get(m.path)
    if (group) group.matches.push(m)
    else groups.set(m.path, { path: m.path, matches: [m] })
  }
  return [...groups.values()]
}

/**
 * 結果の並べ方。既定は `grouped`（ファイルごとにまとめる。VS Code の検索パネルと同じ）、
 * `list` は 1 件 1 行の grep の形。パネルの表示と書き出しの書式が同じ値に従う。
 */
export const SEARCH_RESULT_VIEWS = ['grouped', 'list'] as const
export type SearchResultView = (typeof SEARCH_RESULT_VIEWS)[number]

/**
 * タブへ書き出す本文の行。`list` は grep の形（`パス:行: 内容`）、`grouped` は rg の
 * `--heading` と同じ並び（パスの行、字下げした `行: 内容`、ファイルの間に空行）。
 *
 * **`grouped` の形を変えたら `headingTargetAt` も直す**（あちらがこの形を読む）。
 */
export function formatExtractBody(
  matches: readonly { path: string; line: number; content: string }[],
  rel: (path: string) => string,
  view: SearchResultView,
): string[] {
  if (view === 'list') return matches.map((m) => `${rel(m.path)}:${m.line}: ${m.content}`)
  const lines: string[] = []
  for (const group of groupByFile(matches)) {
    if (lines.length) lines.push('')
    lines.push(rel(group.path))
    for (const m of group.matches) lines.push(`  ${m.line}: ${m.content}`)
  }
  return lines
}

/** 字下げした `行: 内容`。1 つ目のグループが字下げ＋行番号（押せる範囲）。 */
const BODY_RE = /^(\s*\d+):/
/**
 * 見出しのパス。**空白・引用符・末尾のコロンを許さない**（`editorPathJump.ts` の
 * `EXTRACT_LINE_RE` と同じ制限）。緩めると、YAML の `ports:` の下の `80: http` のような
 * 行が「`ports:` というファイルの 80 行目」になる。
 *
 * **区切りや拡張子までは求めない**（ルート直下の `Makefile` を落とす）。代わりに記号だけの
 * 行を `isHeader` で外す: `{` の次の行が `200: 'OK',` のようなソースで、`{` がファイル名に
 * なる。
 */
const HEADER_RE = /^(?:[A-Za-z]:)?[^\s:"'`#][^\s:"'`]*$/

function isHeader(text: string): boolean {
  return HEADER_RE.test(text) && /[\p{L}\p{N}]/u.test(text)
}

/**
 * まとめた書き出しの中で、`lineNo` 行目の `col` 桁目が指すファイルと行（#440）。
 *
 * - 本文の行（`  12: 内容`）の行番号の上 → 上へたどって最初に当たる見出しのファイルの、その行
 * - 見出しの行で、直後が本文の行 → そのファイルの 1 行目
 *
 * **どちらも「見出し＋本文」の組になっているときだけ**当たる。パスだけの行や `12:` で
 * 始まるだけの行は、ふつうのファイルにいくらでもある。
 *
 * @param lineAt 1 始まりの行番号から行の文字列を返す。範囲外は null
 */
export function headingTargetAt(
  lineAt: (n: number) => string | null,
  lineNo: number,
  col: number,
): { path: string; line: number } | null {
  const text = lineAt(lineNo)
  if (text === null) return null
  const body = BODY_RE.exec(text)
  if (body) {
    if (col > body[1].length) return null
    for (let n = lineNo - 1; ; n--) {
      const above = lineAt(n)
      if (above === null) return null
      if (BODY_RE.test(above)) continue
      return isHeader(above) ? { path: above, line: Number(body[1]) } : null
    }
  }
  if (!isHeader(text)) return null
  const next = lineAt(lineNo + 1)
  return next !== null && BODY_RE.test(next) ? { path: text, line: 1 } : null
}
