/**
 * 文字列を HTML へ組み立てるときの共有部品。
 *
 * **`Html` は「エスケープ済み」を型で持つための印**（#284）。プレビューの HTML は文字列の
 * 連結で組むので、「この文字列はもうエスケープしてある」という前提が散文のコメントにしか
 * 現れない状態になりやすい。実際、rst の `anchor()` が生の URL を属性へ差し込んで、引用符で
 * 属性から抜けられる形になっていた。ブランド型にしておけば、生の文字列を属性へ渡す経路は
 * その場でコンパイルエラーになる。
 *
 * `Html` は `string` の部分型なので、テンプレートリテラルにも `innerHTML` にもそのまま置ける。
 * 逆向き（`string` → `Html`）だけが `escapeHtml` か `asHtml` を通る。
 */

declare const HTML_BRAND: unique symbol

export type Html = string & { readonly [HTML_BRAND]: true }

/**
 * 1 文字を数値文字参照にする。**どの文字を逃がすかは呼ぶ側が決める**（`escapeHtml` は HTML の
 * 特殊文字、rst のプレビューは伏せ字に使う私用領域の文字）。書式だけをここに 1 つ持つ。
 */
export function charEntity(c: string): string {
  return `&#${c.charCodeAt(0)};`
}

/**
 * `& < > " '` を数値文字参照にする。**引用符まで含める**のは、属性値へ差し込む用途があるため
 * （`&#34;` はブラウザが属性を読むときにデコードするので、値としては元のまま働く）。
 */
export function escapeHtml(s: string): Html {
  return s.replace(/[&<>"']/g, charEntity) as Html
}

/**
 * 「これは HTML として扱ってよい」と明示する。**自分で組み立てたタグか、既にエスケープ済みの
 * 文字列から切り出したものにだけ使う。** 生の入力に使うと `escapeHtml` を素通しするのと同じ
 * なので、呼ぶ場所には理由を書く。
 */
export function asHtml(s: string): Html {
  return s as Html
}

/** 正規表現に文字列をそのまま埋めるためのエスケープ。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 区切り文字で 1 行を欄に割る（RFC 4180 の引用符に対応）。`"` の中の区切りは区切りではなく、
 * `""` は 1 つの `"`。CSV プレビュー（`.csv` / `.tsv`）と rst の `csv-table` が共有する。
 */
export function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === delimiter) {
      cells.push(cur)
      cur = ''
    } else cur += c
  }
  cells.push(cur)
  return cells
}
