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

/**
 * hunk ヘッダ（`@@ -a,b +c,d @@`）が示す範囲。**省略された行を後から埋めるために要る**（#285）。
 * 埋める中身は変更のない context 行なので左右で同じテキストになり、新しい側のファイルだけで
 * 両方の欄を作れる。
 */
export interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export interface DiffLine {
  left: DiffSide
  right: DiffSide
  /** `type: 'hunk'` の行だけが持つ。 */
  hunk?: HunkRange
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
  // **末尾の改行が作る空要素は行ではない。** context 行として拾うと、実在しない空行が最終行の
  // 次に付き、そのぶん行番号も 1 つ余分に進む。長らく「最後に空行が 1 つ出る」だけだったが、
  // 省略された行を埋める（#285）ようになって、その番号が実ファイルとずれる形で表に出た。
  if (lines[lines.length - 1] === '') lines.pop()
  const result: DiffLine[] = []
  let leftNum = 0
  let rightNum = 0
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // 行数は省略できる（`@@ -1 +1 @@` は 1 行の意味）。
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      let hunk: HunkRange | undefined
      if (match) {
        leftNum = parseInt(match[1], 10) - 1
        rightNum = parseInt(match[3], 10) - 1
        hunk = {
          oldStart: parseInt(match[1], 10),
          oldCount: match[2] === undefined ? 1 : parseInt(match[2], 10),
          newStart: parseInt(match[3], 10),
          newCount: match[4] === undefined ? 1 : parseInt(match[4], 10),
        }
      }
      inHunk = true
      result.push({
        left: { num: null, segments: plain(line), type: 'hunk' },
        right: { num: null, segments: plain(''), type: 'hunk' },
        hunk,
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
