/**
 * Utility functions for font family string handling.
 * Font enumeration is done via Rust (font-kit) — see font_list_monospace command.
 */

export function buildFontFamily(fontName: string): string {
  if (fontName === 'monospace') return 'monospace'
  return `'${fontName}', monospace`
}

export function extractFontName(fontFamily: string): string {
  const match = fontFamily.match(/^'([^']+)'/)
  return match ? match[1] : fontFamily
}
