/**
 * Precomputed line-start offsets. offsets[i] is the byte offset of line (i+1).
 * Use for O(1) line-offset lookup during outline extraction (instead of
 * rescanning from position 0 for each matched line).
 */
export type LineOffsets = number[]

export function buildLineOffsets(text: string): LineOffsets {
  const offsets: LineOffsets = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1)
  }
  return offsets
}

export function lineStart(offsets: LineOffsets, lineNum: number): number {
  const idx = Math.max(0, Math.min(lineNum - 1, offsets.length - 1))
  return offsets[idx]
}
