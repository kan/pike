/**
 * 等幅フォントで数えたときの表示幅（セル数）。
 *
 * 消費者は 2 つある。diff タブの横幅の見積もり（#272。`ch` は「0 の送り幅」＝ 1 セルなので、
 * この値をそのまま `ch` として使える）と、rst の表の桁の切り出し（#284。rst の表は**表示幅**で
 * 桁を合わせる決まりなので、`slice` を code unit で行うと全角を含む表が崩れる）。
 *
 * 全角は 2 セル、タブは 8 セル（`tab-size` を指定していないので CSS の既定値。エディタの
 * `editorTabSize` とは無関係）で数える。どちらも上限側に倒してある: diff では多めに見積もっても
 * 余分にスクロールできるだけだが、少ないとセルの `overflow: hidden` が黙って切る。
 */

/** East Asian Wide / Fullwidth と絵文字のおおまかな範囲（2 セルぶんの幅を持つもの）。 */
export function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/**
 * ASCII を先に片付けるのは、diff が既定（折り返し OFF）で開くたびに全文を 1 度なめるため。
 * code point の反復子は 1 文字ごとに文字列を作るので、素の実装の 4 倍かかる。
 */
export function displayWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x7f) {
      w += c === 9 ? 8 : 1 // 9 = タブ
      continue
    }
    const cp = text.codePointAt(i) ?? c
    if (cp > 0xffff) i++ // サロゲートペアの後半を飛ばす
    w += isWideChar(cp) ? 2 : 1
  }
  return w
}

/**
 * 表示幅で数えた `[from, to)` を切り出す（rst の表の桁の切り出し用）。
 *
 * **境界が全角の途中に落ちたら、その文字は手前の欄に入れる。** rst の表は罫線と本文の桁が
 * 揃っている前提なので通常は起きないが、揃っていない表でも文字を落とさないようにする。
 *
 * `displayWidth` と同じく `charCodeAt` で回し、切り出しは添字 1 回の `slice` で済ませる。
 * 表は**列ごとに**この関数を呼ぶので、code point の反復子（1 文字ごとに文字列を作る）や
 * 1 文字ずつの連結にすると、列数を係数として効いてくる。
 */
export function sliceByWidth(text: string, from: number, to: number): string {
  let w = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    if (w >= to) return text.slice(start === -1 ? i : start, i)
    if (start === -1 && w >= from) start = i
    const c = text.charCodeAt(i)
    if (c < 0x7f) {
      w += c === 9 ? 8 : 1
      continue
    }
    const cp = text.codePointAt(i) ?? c
    if (cp > 0xffff) i++
    w += isWideChar(cp) ? 2 : 1
  }
  return start === -1 ? '' : text.slice(start)
}
