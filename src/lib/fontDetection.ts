/**
 * Utility functions for font family string handling.
 * Font enumeration is done via Rust (font-kit) — see font_list_monospace command.
 */

/** Quote a font family for CSS, escaping single quotes (e.g. a font named O'Hara). */
function quoteFamily(name: string): string {
  return `'${name.replace(/'/g, "\\'")}'`
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
