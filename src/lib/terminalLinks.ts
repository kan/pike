/**
 * Detect `path:line` / `path:line:col` references in terminal output so they can
 * be turned into clickable links that open the file in an editor tab.
 *
 * Coding agents (Claude Code, etc.) emit paths, errors, and stack traces
 * constantly; this is the bridge from that output back into Pike's editor.
 *
 * 拾うのは 2 通り。`path:line(:col)` の参照（エラーやスタックトレース）と、行番号の
 * 無い**裸のパス**（#252。Claude Code が書いたファイルを
 * `› [file] /tmp/…/test.md (7.7KB)` の形で案内してくる）。後者は行の一部として現れる
 * ので、行全体がパスであることを求める `asPathHeader` では拾えない。
 */

export interface PathLinkMatch {
  /** String index of the match within the source line. */
  index: number
  /** Length of the matched substring. */
  length: number
  /** File path portion (may be relative or absolute, `/` or `\` separators). */
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based column, when present. */
  col?: number
}

/** The subset needed to open a file — the link's source position is irrelevant here. */
export type PathLinkTarget = Pick<PathLinkMatch, 'path' | 'line' | 'col'>

// A path token ending in `.ext` (1–12 word chars), optionally prefixed by a
// Windows drive (`C:`), optionally followed by `:line` and `:col`. Requiring an
// extension keeps false positives (timestamps like `12:34`, ranges) low.
//
// 末尾の先読みは、拡張子の後ろにパスがまだ続くものを落とすため。無いと
// `node_modules/.bin/tsc` が内側のドットまで戻って `node_modules/.bin` になり、
// 指していないディレクトリを開くことになる。
const PATH_RE = /(?:[A-Za-z]:)?[\w.\-/\\@~]+\.\w{1,12}(?::\d+(?::\d+)?)?(?![\w.\-/\\@~])/g

// Split a matched token into path / line / col. Lazy `.+?` keeps a leading
// Windows drive colon (`C:\foo.rs`) with the path instead of mis-splitting it.
const SPLIT_RE = /^(.+?):(\d+)(?::(\d+))?$/

/** パスの一部として現れうる文字。`:` はスキームとドライブの両方で使うので含める。 */
const PATH_CHAR_RE = /[\w.:\-/\\@~]/

/**
 * 行番号の付かないトークンを、パスとして扱ってよいか。
 *
 * **行番号があるときより厳しくする。** `main.rs:42` は行番号自体が「ファイルの話を
 * している」証拠になるが、裸の `foo.md` は文章中の語と見分けが付かない。そこで区切りを
 * 必須にして、`foo.md` を落とし `src/foo.md` を通す。
 *
 * さらに**先頭のセグメントがホスト名に見えるものを落とす**。スキーム付きの URL は
 * 呼び出し側の `/` ガードが弾くが、`www.example.com/a/b.html` のように裸で書かれると
 * すり抜けてファイルとして開きにいく。ドットを含むかで見分け、ただし `.` で始まるものは
 * 除く（`.claude/rules/editor.md` は実在するパス）。
 */
function isPathLike(path: string): boolean {
  if (!/[/\\]/.test(path)) return false
  const first = path.split(/[/\\]/)[0]
  // 絶対パス（先頭が空）と Windows のドライブは、そもそもホスト名に見えない。
  if (first === '' || /^[A-Za-z]:$/.test(first)) return true
  return !first.includes('.') || first.startsWith('.')
}

// ── rg / grep "heading" output ──────────────────────────────────────────────
// When ripgrep writes to a TTY (Pike's PTY) it groups matches under a bare
// filename header, so the match lines themselves carry no path — only
// `<lineno>:<text>`. These helpers let the link provider walk up to the header
// and link the line number back to its file.

// rg body line: match (`12:`) or context (`12-`).
const RG_BODY_RE = /^\d+[:-]/

/** A match line `<lineno>:<text>`. Returns the line number and its digit width. */
export function parseRgMatchLine(text: string): { line: number; numLen: number } | null {
  const m = /^(\d+):/.exec(text)
  if (!m) return null
  return { line: Number(m[1]), numLen: m[1].length }
}

/** True for any rg body line — match (`12:`) or context (`12-`). */
export function isRgBodyLine(text: string): boolean {
  return RG_BODY_RE.test(text.trimStart())
}

/** A bare file-path line (rg group header, `ls` of one file, …). Returns the path. */
export function asPathHeader(text: string): string | null {
  const s = text.trim()
  if (!s || s === '--') return null // `--` separates rg context groups
  if (RG_BODY_RE.test(s)) return null // a match / context line, not a header
  if (/\s/.test(s)) return null // headers are a lone path, no spaces
  if (s.includes('/') || s.includes('\\') || /\.\w{1,12}$/.test(s)) return s
  return null
}

export function findPathLinks(text: string): PathLinkMatch[] {
  const out: PathLinkMatch[] = []
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = m[0]
    const idx = m.index
    // **パスは境界から始まる。** 直前がパスに使える文字なら、それはもっと長い何かの
    // 途中を切り出しただけ。行番号を必須にしていた頃は `:数字` で終わる形が守って
    // いたが、任意にしたことで URL の残骸が通るようになった（実測）:
    //   `http://localhost:5173/main.js` → `t:5173/main.js`（`t:` をドライブと読む）
    //   `http://127.0.0.1:8080/static/app.css` → `/static/app.css`（ポートの後ろから再開）
    //   `git@github.com:owner/repo.git` → `owner/repo.git`
    // URL は WebLinksAddon の担当なので、ここでは触らない。
    if (idx > 0 && PATH_CHAR_RE.test(text[idx - 1])) continue
    // **スキームを Windows のドライブと読み違えない。** `(?:[A-Za-z]:)?` は
    // `https://example.com/a/b.md` の `s:` にも当たるので、行番号を必須にしていた頃は
    // 弾かれていた URL がここまで来る（`:数字` で終わらないため）。パスに `://` は
    // 現れないので、これで見分ける。
    if (raw.includes('://')) continue
    const parts = SPLIT_RE.exec(raw)
    if (parts) {
      out.push({
        index: idx,
        length: raw.length,
        path: parts[1],
        line: Number(parts[2]),
        col: parts[3] ? Number(parts[3]) : undefined,
      })
      continue
    }
    // 行番号が無いトークン。開くのは 1 行目。
    if (!isPathLike(raw)) continue
    out.push({ index: idx, length: raw.length, path: raw, line: 1 })
  }
  return out
}
