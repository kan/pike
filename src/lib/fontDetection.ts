/**
 * Utility functions for font family string handling.
 * Font enumeration is done via Rust (font-kit) — see font_list_monospace command.
 */

/** Quote a font family for CSS (e.g. a font named O'Hara). Escapes backslashes
 *  first, then single quotes, so a name ending in `\` can't break out of the
 *  quoted string. Strips control chars that can't appear in a CSS string. */
function quoteFamily(name: string): string {
  const escaped = name
    .replace(/[\n\r\f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
  return `'${escaped}'`
}

export function buildFontFamily(fontName: string): string {
  const name = fontName.trim()
  if (!name || name === 'monospace') return 'monospace'
  return `${quoteFamily(name)}, monospace`
}

export function extractFontName(fontFamily: string): string {
  const match = fontFamily.match(/^'([^']+)'/)
  return match ? match[1] : fontFamily
}

/** Fallback stack for the app/UI (proportional) font. */
export const UI_FONT_FALLBACK = 'system-ui, -apple-system, sans-serif'

/**
 * Build the CSS font-family value for the UI font.
 * An empty name means "System Default" → just the fallback stack.
 */
export function buildUiFontFamily(fontName: string): string {
  const name = fontName.trim()
  if (!name) return UI_FONT_FALLBACK
  return `${quoteFamily(name)}, ${UI_FONT_FALLBACK}`
}

/** Nerd Font の Powerline の区切り記号（私用領域 U+E0B0）。アイコンが描けるかの見本にする。 */
const NERD_FONT_SAMPLE = ''

/** 名前から Nerd Font らしいか（`PlemolJP Console NF`、`Hack Nerd Font` など）。 */
function looksLikeNerdFont(name: string): boolean {
  return /\bNF\b|Nerd Font/i.test(name)
}

/**
 * `text` を `font` で描いた画素。比べるためだけの小さな canvas で、毎回作り直す
 * （フォントを選び直したときにしか呼ばない）。
 */
function renderPixels(font: string, text: string): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 48
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.font = font
  ctx.textBaseline = 'top'
  ctx.fillText(text, 4, 4)
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data
}

/**
 * `fontName` が `text` を実際に描いているか（#372）。
 *
 * 「`'X', serif`」と「`serif`」で同じ文字を描き、画素が一致すれば X は使われていない
 * （どちらも serif 側のフォールバックで描かれた）とみなす。相手を `monospace` にしないのは、
 * X が既定の等幅フォント（Consolas や Menlo）と同じだと、使われていても一致してしまうため。
 *
 * **canvas は DOM と同じ WebKit / Chromium のフォントの仕組みを通る**ので、ターミナル
 * （xterm.js の DOM レンダラー）と同じ答えになる。判定できない環境（canvas が使えない）は
 * 「描いている」として扱う（誤って警告しない側）。
 */
function rendersWith(fontName: string, text: string): boolean {
  const withFont = renderPixels(`32px ${quoteFamily(fontName)}, serif`, text)
  const fallback = renderPixels('32px serif', text)
  if (!withFont || !fallback) return true
  for (let i = 0; i < withFont.length; i++) if (withFont[i] !== fallback[i]) return true
  return false
}

/**
 * 選んだフォントが表示に使われているか（#372）。
 *
 * - `'missing'` … フォントそのものが使われていない（入っていない、または Pike の起動後に入れた）
 * - `'icons'` … Nerd Font なのに、アイコン（私用領域の文字）がそのフォントで描かれていない
 * - `null` … 問題なし（または判定しない）
 *
 * **macOS の WebKit は、起動後に入れたフォントの私用領域の文字を再起動まで拾わない**
 * （通常の文字は新しいフォントで描かれる）。ここでは検出して再起動を促すところまでを行う。
 *
 * **原因の在りかは未確認。** フォールバック先を覚えているのが WebKit のプロセス全体の
 * キャッシュなら、canvas も同じく化けるのでこの検出が働く（再起動しか手が無い）。フォントの
 * 指定ごとのキャッシュなら、canvas は新しい指定で描くので正しく描けてしまい、検出は
 * 見逃す（誤って警告はしない）。その場合は `font-family` の文字列を変えるだけで直る可能性が
 * あるので、macOS で切り分けてから手を足す（#372）。
 */
export type FontNotice = 'missing' | 'icons'

export function checkFontRendering(fontName: string): FontNotice | null {
  const name = fontName.trim()
  if (!name || name === 'monospace') return null
  if (!rendersWith(name, 'M@gj')) return 'missing'
  if (looksLikeNerdFont(name) && !rendersWith(name, NERD_FONT_SAMPLE)) return 'icons'
  return null
}
