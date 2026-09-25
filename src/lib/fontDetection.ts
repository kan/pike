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
