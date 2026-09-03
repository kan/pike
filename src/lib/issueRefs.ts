/**
 * issue タブの本文の `#123` を、別の issue タブを開くリンクにする（#278）。
 *
 * **GitHub 側の変換なので、生の Markdown には残らない。** `gh` が返す本文は
 * `#123` のままで、`marked` はこれをただの文字として出す。だから自前で拾う。
 *
 * **コードスパンとコードブロックの中は素通しになる。** marked は先に `codespan` /
 * `code` を取るので、この inline 拡張はそこへ入らない（自前で除外を書く必要が無いのが
 * 拡張として書く理由でもある）。
 *
 * 拾わないもの:
 * - **語の途中**（`foo#1`）。直前の文字が空白か開き括弧のときだけ拾う
 * - **`owner/repo#123` と `GH-123`**。別リポジトリは `gh issue view --repo` が要るうえ、
 *   タブの dedupe キー（番号 ＋ プロジェクト）が足りなくなる
 *
 * `#123456` のような桁数のものは拾う（GitHub も issue として扱うので揃う）。CSS の色は
 * `#a2eeef` のように英字から始まるので当たらない。
 */

import type { MarkedExtension, Tokens } from 'marked'

/** 行頭の `#123`。直後に語を続けない（`#1abc` は拾わない）。 */
const REF_RE = /^#(\d{1,7})(?![\w-])/

/** 直前に来てよい文字。空白と、日本語の文章で番号を囲う括弧。 */
const BOUNDARY_RE = /[\s([{【「（]/

interface IssueRefToken extends Tokens.Generic {
  number: number
}

export function issueRefs(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'issueRef',
        level: 'inline',
        start(src: string) {
          return /#\d/.exec(src)?.index
        },
        tokenizer(src: string, tokens?: Tokens.Generic[]) {
          const m = REF_RE.exec(src)
          if (!m) return undefined
          // **直前の文字は 1 つ前のトークンの末尾から見る。** tokenizer は現在位置から
          // 先しか受け取らないので、語中（`foo#1`）を弾くにはこれが唯一の手がかり。
          // トークンが無い＝段落の先頭なので、そのときは拾ってよい。
          const prev = tokens?.[tokens.length - 1]
          const before = typeof prev?.raw === 'string' ? prev.raw.slice(-1) : ''
          if (before && !BOUNDARY_RE.test(before)) return undefined
          return { type: 'issueRef', raw: m[0], number: Number(m[1]) } satisfies IssueRefToken
        },
        renderer(token: Tokens.Generic) {
          const n = (token as IssueRefToken).number
          // `href` は付けない: 行き先は Pike の中のタブで、URL ではない。クリックは
          // `IssueTab` が `data-issue` で拾う（`href` を付けると、拾い損ねたときに
          // WebView がそこへ飛ぶ余地が残る）。
          return `<a class="issue-ref" data-issue="${n}">#${n}</a>`
        },
      },
    ],
  }
}
