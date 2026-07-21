/**
 * Plain-text search over a parsed diff (DiffTab, #176). The diff is rendered as
 * an HTML table of char-level highlighted segments, so CodeMirror's search can't
 * be reused — this finds matches in the joined cell text and produces render
 * tokens that overlay the search highlight on top of the diff highlight.
 */
import type { DiffLine, DiffSegment } from './diffParser'

export type MatchSide = 'left' | 'right'

export interface DiffMatch {
  row: number
  side: MatchSide
  start: number
  end: number
}

/** Every occurrence of `query` in `text`, as [start, end) ranges. */
export function findRanges(text: string, query: string, caseSensitive: boolean): [number, number][] {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: [number, number][] = []
  for (let from = hay.indexOf(needle); from !== -1; from = hay.indexOf(needle, from + needle.length)) {
    ranges.push([from, from + needle.length])
  }
  return ranges
}

/** Matches across the whole diff in document order (row, then left before right). */
export function collectMatches(lines: DiffLine[], query: string, caseSensitive: boolean): DiffMatch[] {
  const out: DiffMatch[] = []
  if (!query) return out
  lines.forEach((line, row) => {
    for (const side of ['left', 'right'] as const) {
      const text = line[side].segments.map((s) => s.text).join('')
      for (const [start, end] of findRanges(text, query, caseSensitive)) {
        out.push({ row, side, start, end })
      }
    }
  })
  return out
}

export interface RenderToken {
  text: string
  /** Char-level diff highlight (from parseDiff). */
  diffHl: boolean
  /** Global match index this token belongs to, or -1 when it's not a match. */
  matchIndex: number
}

/**
 * Split a cell's diff segments into render tokens, cutting them at the search
 * ranges so a match can carry its own styling without losing the diff
 * highlight. `ranges` are cell-local [start, end) with the global match index;
 * the current-match emphasis is applied by the caller from `matchIndex`.
 */
export function renderTokens(
  segments: DiffSegment[],
  ranges: { start: number; end: number; index: number }[],
): RenderToken[] {
  // Common case (search closed / no match in this cell): one token per segment,
  // skipping the cut-set machinery entirely.
  if (ranges.length === 0) {
    return segments.map((s) => ({ text: s.text, diffHl: s.highlight, matchIndex: -1 }))
  }
  const tokens: RenderToken[] = []
  let offset = 0
  for (const seg of segments) {
    const segStart = offset
    const segEnd = offset + seg.text.length
    offset = segEnd
    // Cut the segment at its own edges plus any range edge falling inside it.
    // Each resulting piece [a, b) is then wholly inside or outside a range, so
    // its start `a` alone decides membership.
    const cuts = new Set<number>([segStart, segEnd])
    for (const r of ranges) {
      if (r.start > segStart && r.start < segEnd) cuts.add(r.start)
      if (r.end > segStart && r.end < segEnd) cuts.add(r.end)
    }
    const sorted = [...cuts].sort((a, b) => a - b)
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k]
      const b = sorted[k + 1]
      const hit = ranges.find((r) => r.start <= a && a < r.end)
      tokens.push({
        text: seg.text.slice(a - segStart, b - segStart),
        diffHl: seg.highlight,
        matchIndex: hit ? hit.index : -1,
      })
    }
  }
  return tokens
}
