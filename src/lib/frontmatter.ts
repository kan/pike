/**
 * Front matter has no specification. Jekyll (2008) started the `---` fence and the
 * other generators copied it, so the delimiters differ per implementation and neither
 * CommonMark nor GFM says anything about them. Pike only accepts a block that starts on
 * the very first line, which is the line every generator agrees on and keeps a `---`
 * in the middle of a document from being mistaken for one.
 *
 * Range detection lives here, on its own, with no dependencies: the outline extractor
 * needs nothing else, and the YAML/TOML parsers in `frontmatterParse.ts` would otherwise
 * ride along into the chunk that every language's outline loads.
 */
export type FrontmatterKind = 'yaml' | 'toml' | 'json'

export interface FrontmatterBlock {
  kind: FrontmatterKind
  /** The block body, without the delimiter lines (JSON keeps its braces). */
  raw: string
  /** Offset of the first character after the block, i.e. where the body starts. */
  bodyFrom: number
}

/** A leading BOM is invisible but shifts every offset, so measure it once. */
function bomLength(text: string): number {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0
}

/** Scan the lines after the opening fence for the closing one. */
function findFenced(text: string, openEnd: number, fence: string): { closeStart: number; end: number } | null {
  let lineStart = openEnd
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? text.length : nl
    // Delimiter lines may carry trailing whitespace; nothing else.
    if (text.slice(lineStart, lineEnd).trimEnd() === fence) {
      return { closeStart: lineStart, end: nl < 0 ? text.length : nl + 1 }
    }
    if (nl < 0) return null
    lineStart = nl + 1
  }
  return null
}

/** Hugo's JSON front matter has no fence, so the block ends where the braces balance. */
function findJsonEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * Locate a front matter block at the very start of `text`.
 *
 * Shared by the Markdown preview (which slices the body off before `marked.parse`) and
 * the outline extractor (which drops the headings Lezer finds inside the block).
 */
export function detectFrontmatter(text: string): FrontmatterBlock | null {
  const bom = bomLength(text)
  const nl = text.indexOf('\n', bom)
  const firstLine = (nl < 0 ? text.slice(bom) : text.slice(bom, nl)).trimEnd()

  if (firstLine === '---' || firstLine === '+++') {
    if (nl < 0) return null
    const fence = findFenced(text, nl + 1, firstLine)
    if (!fence) return null
    const kind = firstLine === '---' ? 'yaml' : 'toml'
    return { kind, raw: text.slice(nl + 1, fence.closeStart), bodyFrom: fence.end }
  }

  if (firstLine.startsWith('{')) {
    const end = findJsonEnd(text, bom)
    if (end === null) return null
    return { kind: 'json', raw: text.slice(bom, end), bodyFrom: end }
  }

  return null
}
