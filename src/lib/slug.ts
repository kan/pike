/**
 * Heading slug for Markdown preview anchors.
 *
 * Mirrors the GitHub-style anchors used in the docs: lower-case, drop everything
 * that isn't a letter (incl. CJK), number, underscore, hyphen or whitespace, then
 * turn each remaining whitespace character into a hyphen. Consecutive separators
 * are intentionally kept (`a / b` → `a--b`) to match how GitHub renders them.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

/**
 * Returns a slugger that de-duplicates within a single document: repeated
 * headings get `-1`, `-2`, … suffixes (same scheme as GitHub / github-slugger).
 */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = slugifyHeading(text)
    const used = seen.get(base)
    if (used === undefined) {
      seen.set(base, 0)
      return base
    }
    const next = used + 1
    seen.set(base, next)
    return `${base}-${next}`
  }
}
