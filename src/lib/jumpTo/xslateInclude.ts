/**
 * Text::Xslate（Kolon）の `include` / `cascade` の引数から、テンプレート名を取り出す。
 *
 * - 文字列はそのまま名前にする（`: include "parts/footer.tx"`）
 * - 裸の名前は Xslate と同じく `::` を `/` にして `.tx` を足す（`: cascade myapp::base` →
 *   `myapp/base.tx`）
 * - `cascade base with macros::a, macros::b` のように `with` の後ろに並べたものも同じ扱い
 *
 * **見るのは Kolon のコードの中だけ**（行頭の `:` から行末まで、または `<: … :>` の内側）。
 * HTML の地の文の「include」という語で下線を出さないため。
 *
 * **tauri を import しない**（Node のテストから読むため）。解決は `index.ts` が行う。
 */

export interface XslateTemplateRef {
  /** 探すテンプレートのパス（テンプレートのディレクトリからの相対）。 */
  name: string
  /** 行の中の位置。文字列なら引用符を含む。 */
  from: number
  to: number
}

/**
 * Kolon の行コードの始まり（行頭の `:`。`:>` は `<: :>` の閉じなので除く）。**ハイライト
 * （`templateModes.ts` の `xslate`）もこれを使う**。片方だけ直すと、色の付く範囲と
 * Ctrl+Click が効く範囲が食い違う。ハイライトは `lastIndex` から探すので `g` を付けてある。
 */
export const KOLON_LINE_CODE = /^[ \t]*:(?!>)/g

/** 行の中の Kolon のコードの範囲 `[from, to)`。 */
function codeSpans(line: string): [number, number][] {
  // `g` 付きの `match` は `lastIndex` を見ずに先頭から探す（共有している正規表現の状態に依らない）。
  const lineCode = line.match(KOLON_LINE_CODE)
  if (lineCode) return [[lineCode[0].length, line.length]]
  const spans: [number, number][] = []
  for (const m of line.matchAll(/<:([\s\S]*?)(?::>|$)/g)) {
    const from = (m.index ?? 0) + 2
    spans.push([from, from + m[1].length])
  }
  return spans
}

const STATEMENT = /\b(?:include|cascade)\b([^{;]*)/g
// 裸の名前は `$` / `.` の直後を除く。`: include $tmpl` や `$c.req.path` の変数を名前と読まない。
const TARGET = /"([^"]*)"|'([^']*)'|(?<![$.\w])([A-Za-z_]\w*(?:::\w+)*)/g

/** `col` にある include / cascade の対象。無ければ null。 */
export function xslateTemplateAt(line: string, col: number): XslateTemplateRef | null {
  for (const [from, to] of codeSpans(line)) {
    if (col < from || col > to) continue
    const code = line.slice(from, to)
    for (const st of code.matchAll(STATEMENT)) {
      const argsFrom = from + (st.index ?? 0) + st[0].length - st[1].length
      for (const t of st[1].matchAll(TARGET)) {
        const bare = t[3]
        if (bare === 'with') continue
        const start = argsFrom + (t.index ?? 0)
        const end = start + t[0].length
        if (col < start || col > end) continue
        const name = bare ? `${bare.replaceAll('::', '/')}.tx` : (t[1] ?? t[2])
        return name ? { name, from: start, to: end } : null
      }
    }
  }
  return null
}
