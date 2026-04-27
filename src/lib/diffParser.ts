export type DiffLineType = 'hunk' | 'del' | 'add' | 'ctx' | 'empty'

export interface DiffSegment {
  text: string
  highlight: boolean
}

export interface DiffSide {
  num: number | null
  segments: DiffSegment[]
  type: DiffLineType
}

export interface DiffLine {
  left: DiffSide
  right: DiffSide
}

function plain(text: string): DiffSegment[] {
  return [{ text, highlight: false }]
}

function charDiff(oldStr: string, newStr: string): { left: DiffSegment[]; right: DiffSegment[] } {
  let prefix = 0
  while (prefix < oldStr.length && prefix < newStr.length && oldStr[prefix] === newStr[prefix]) {
    prefix++
  }
  let suffixOld = oldStr.length
  let suffixNew = newStr.length
  while (suffixOld > prefix && suffixNew > prefix && oldStr[suffixOld - 1] === newStr[suffixNew - 1]) {
    suffixOld--
    suffixNew--
  }

  const left: DiffSegment[] = []
  const right: DiffSegment[] = []
  if (prefix > 0) {
    left.push({ text: oldStr.slice(0, prefix), highlight: false })
    right.push({ text: newStr.slice(0, prefix), highlight: false })
  }
  const oldMid = oldStr.slice(prefix, suffixOld)
  const newMid = newStr.slice(prefix, suffixNew)
  if (oldMid) left.push({ text: oldMid, highlight: true })
  if (newMid) right.push({ text: newMid, highlight: true })
  if (suffixOld < oldStr.length) {
    left.push({ text: oldStr.slice(suffixOld), highlight: false })
    right.push({ text: newStr.slice(suffixNew), highlight: false })
  }
  return {
    left: left.length ? left : [{ text: '', highlight: false }],
    right: right.length ? right : [{ text: '', highlight: false }],
  }
}

function findLastUnpairedDel(lines: DiffLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i]
    if (r.left.type === 'del' && r.right.type === 'empty') return i
    if (r.left.type !== 'del') break
  }
  return -1
}

/**
 * Parse a unified-diff string into an array of side-by-side rows.
 *
 * When `charLevel` is true, paired `-`/`+` lines are character-diffed and the
 * differing slices are marked `highlight: true` so the renderer can emphasise
 * them. With `charLevel: false`, each side has a single non-highlighted
 * segment containing the full line text.
 */
export function parseDiff(raw: string, opts: { charLevel?: boolean } = {}): DiffLine[] {
  const charLevel = opts.charLevel ?? false
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let leftNum = 0
  let rightNum = 0
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        leftNum = parseInt(match[1], 10) - 1
        rightNum = parseInt(match[2], 10) - 1
      }
      inHunk = true
      result.push({
        left: { num: null, segments: plain(line), type: 'hunk' },
        right: { num: null, segments: plain(''), type: 'hunk' },
      })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('-')) {
      leftNum++
      result.push({
        left: { num: leftNum, segments: plain(line.slice(1)), type: 'del' },
        right: { num: null, segments: plain(''), type: 'empty' },
      })
    } else if (line.startsWith('+')) {
      rightNum++
      const lastUnpaired = findLastUnpairedDel(result)
      if (lastUnpaired !== -1) {
        if (charLevel) {
          const oldText = result[lastUnpaired].left.segments.map((s) => s.text).join('')
          const newText = line.slice(1)
          const { left: leftSegs, right: rightSegs } = charDiff(oldText, newText)
          result[lastUnpaired].left.segments = leftSegs
          result[lastUnpaired].right = { num: rightNum, segments: rightSegs, type: 'add' }
        } else {
          result[lastUnpaired].right = { num: rightNum, segments: plain(line.slice(1)), type: 'add' }
        }
      } else {
        result.push({
          left: { num: null, segments: plain(''), type: 'empty' },
          right: { num: rightNum, segments: plain(line.slice(1)), type: 'add' },
        })
      }
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignore
    } else {
      leftNum++
      rightNum++
      result.push({
        left: { num: leftNum, segments: plain(line.slice(1)), type: 'ctx' },
        right: { num: rightNum, segments: plain(line.slice(1)), type: 'ctx' },
      })
    }
  }
  return result
}
