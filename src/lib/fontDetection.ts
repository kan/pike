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

/**
 * OS の UI フォント（設定画面そのものと、UI フォントを「システムの既定」にしたときに使う）。
 *
 * **撮影用ビルドだけは Yu Gothic UI を名指しする**（#506）。CI の Windows ランナーは英語版で、
 * `system-ui` が Segoe UI になる。表示言語は変えられないので、日本語の Windows と同じ絵になる
 * よう名前で指す。日本語の Windows ではどちらも Yu Gothic UI で描かれるので、手元の撮影は
 * 変わらない。通常ビルドでは `__PIKE_E2E__` が false 定数なので分岐ごと消える。
 * 撮影の検査側の値は `e2e/support/prepare.ts` の `CAPTURE_ENV.uiFont` で、変えるなら両方変える。
 */
export const SYSTEM_UI_FONT = __PIKE_E2E__
  ? '"Yu Gothic UI", system-ui, -apple-system, sans-serif'
  : 'system-ui, -apple-system, sans-serif'

/** Fallback stack for the app/UI (proportional) font. */
export const UI_FONT_FALLBACK = SYSTEM_UI_FONT

/**
 * Build the CSS font-family value for the UI font.
 * An empty name means "System Default" → just the fallback stack.
 */
export function buildUiFontFamily(fontName: string): string {
  const name = fontName.trim()
  if (!name) return UI_FONT_FALLBACK
  return `${quoteFamily(name)}, ${UI_FONT_FALLBACK}`
}
