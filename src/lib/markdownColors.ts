/**
 * コードスパンの中身が色の値だけのとき（`` `#0969DA` `` / `` `rgb(9, 105, 218)` `` /
 * `` `hsl(212, 92%, 45%)` ``）、横に小さな色見本を付ける（#482。GitHub と同じ）。
 * 文中の素の `#0969DA` は対象外。
 *
 * 見本の色はインラインの `style` で塗る（DOMPurify は `style` 属性を既定で通す）。
 * **値は下の正規表現に一致したものだけを `style` へ入れる。** 通す文字は数字・英字・`#` `%` `.`
 * `,` `/` `(` `)` と空白だけで、`;` や引用符が無いので、宣言の外へ抜けられない。
 */

import type { MarkedExtension, Tokens } from 'marked'
import { escapeHtml } from './text'

const N = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`
const ALPHA = `${N}%?`
const COLOR_RES = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  // rgb(9, 105, 218) / rgba(9, 105, 218, 0.5) / rgb(9 105 218 / 50%)
  new RegExp(String.raw`^rgba?\(\s*${N}%?\s*,\s*${N}%?\s*,\s*${N}%?\s*(?:,\s*${ALPHA}\s*)?\)$`, 'i'),
  new RegExp(String.raw`^rgba?\(\s*${N}%?\s+${N}%?\s+${N}%?\s*(?:\/\s*${ALPHA}\s*)?\)$`, 'i'),
  // hsl(212, 92%, 45%) / hsla(212, 92%, 45%, 0.5) / hsl(212deg 92% 45% / 50%)
  new RegExp(String.raw`^hsla?\(\s*${N}(?:deg)?\s*,\s*${N}%\s*,\s*${N}%\s*(?:,\s*${ALPHA}\s*)?\)$`, 'i'),
  new RegExp(String.raw`^hsla?\(\s*${N}(?:deg)?\s+${N}%?\s+${N}%?\s*(?:\/\s*${ALPHA}\s*)?\)$`, 'i'),
]

/** 色の値だけでできていれば、その値（前後の空白を落としたもの）。 */
export function colorValue(text: string): string | null {
  const value = text.trim()
  return COLOR_RES.some((re) => re.test(value)) ? value : null
}

export function colorSwatches(): MarkedExtension {
  return {
    renderer: {
      codespan(token: Tokens.Codespan) {
        const value = colorValue(token.text)
        if (!value) return false
        // marked の既定と同じく本文はエスケープする（`token.text` は生のまま来る）。
        return `<code>${escapeHtml(token.text)}<span class="color-swatch" style="background-color: ${escapeHtml(value)}"></span></code>`
      },
    },
  }
}
