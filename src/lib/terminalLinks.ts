/**
 * Detect `path:line` / `path:line:col` references in terminal output so they can
 * be turned into clickable links that open the file in an editor tab.
 *
 * Coding agents (Claude Code, etc.) emit paths, errors, and stack traces
 * constantly; this is the bridge from that output back into Pike's editor.
 */

export interface PathLinkMatch {
  /** String index of the match within the source line. */
  index: number
  /** Length of the matched substring. */
  length: number
  /** File path portion (may be relative or absolute, `/` or `\` separators). */
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based column, when present. */
  col?: number
}

/** The subset needed to open a file — the link's source position is irrelevant here. */
export type PathLinkTarget = Pick<PathLinkMatch, 'path' | 'line' | 'col'>

// A path token ending in `.ext` (1–12 word chars), optionally prefixed by a
// Windows drive (`C:`), followed by `:line` and an optional `:col`. Requiring an
// extension keeps false positives (timestamps like `12:34`, ranges) low.
const PATH_LINE_RE = /(?:[A-Za-z]:)?[\w.\-/\\@~]+\.\w{1,12}:\d+(?::\d+)?/g

// Split a matched token into path / line / col. Lazy `.+?` keeps a leading
// Windows drive colon (`C:\foo.rs`) with the path instead of mis-splitting it.
const SPLIT_RE = /^(.+?):(\d+)(?::(\d+))?$/

// ── rg / grep "heading" output ──────────────────────────────────────────────
// When ripgrep writes to a TTY (Pike's PTY) it groups matches under a bare
// filename header, so the match lines themselves carry no path — only
// `<lineno>:<text>`. These helpers let the link provider walk up to the header
// and link the line number back to its file.

// rg body line: match (`12:`) or context (`12-`).
const RG_BODY_RE = /^\d+[:-]/

/** A match line `<lineno>:<text>`. Returns the line number and its digit width. */
export function parseRgMatchLine(text: string): { line: number; numLen: number } | null {
  const m = /^(\d+):/.exec(text)
  if (!m) return null
  return { line: Number(m[1]), numLen: m[1].length }
}

/** True for any rg body line — match (`12:`) or context (`12-`). */
export function isRgBodyLine(text: string): boolean {
  return RG_BODY_RE.test(text.trimStart())
}

/** A bare file-path line (rg group header, `ls` of one file, …). Returns the path. */
export function asPathHeader(text: string): string | null {
  const s = text.trim()
  if (!s || s === '--') return null // `--` separates rg context groups
  if (RG_BODY_RE.test(s)) return null // a match / context line, not a header
  if (/\s/.test(s)) return null // headers are a lone path, no spaces
  if (s.includes('/') || s.includes('\\') || /\.\w{1,12}$/.test(s)) return s
  return null
}

export function findPathLinks(text: string): PathLinkMatch[] {
  const out: PathLinkMatch[] = []
  PATH_LINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = PATH_LINE_RE.exec(text)) !== null) {
    const raw = m[0]
    const idx = m.index
    // A genuine path consumes its own slashes, so a match preceded by `/` is a
    // URL host:port fragment (e.g. `example.com:8080` in `http://…`). Skip it —
    // URLs are handled by WebLinksAddon.
    if (idx > 0 && text[idx - 1] === '/') continue
    const parts = SPLIT_RE.exec(raw)
    if (!parts) continue
    out.push({
      index: idx,
      length: raw.length,
      path: parts[1],
      line: Number(parts[2]),
      col: parts[3] ? Number(parts[3]) : undefined,
    })
  }
  return out
}
