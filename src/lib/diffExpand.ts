/**
 * hunk と hunk のあいだで省略された行を、後から差し込むための計算（#285）。
 *
 * `git diff` は変更の前後 3 行しか出さないので、hunk と hunk のあいだは省略される。GitHub や
 * VS Code と同じく、その境目から少しずつ広げられるようにする。
 *
 * **取り寄せるのは「新しい側」のファイルだけでよい。** 省略されているのは変更のない context 行
 * なので、左右の欄は同じテキストになる。行番号は `HunkRange`（`diffParser.ts`）から引ける。
 *
 * ここは純粋な計算だけを持ち、取得（IPC）と操作（ボタン）は `DiffTab.vue` の担当。
 */

import type { DiffLine } from './diffParser'

/** ある省略領域を、上端／下端から何行めくったか。 */
export interface Expanded {
  top: number
  bottom: number
}

/**
 * 省略された領域の帯。**広げ切ったあとも残る**（`count` が 0 になるだけ）: 畳み直す入口が
 * そこにしか無く、消してしまうと一度広げた領域を元に戻せない。
 */
export interface Gap {
  /**
   * 展開の状態を持つキー。**直後の hunk の `src` での位置**（末尾の領域だけはその長さ）で、
   * 展開しても動かない。`at` は広げるたびに動くので、そちらを覚えると行き先を見失う。
   */
  key: number
  /** `lines` のこの位置の前に帯を出す。 */
  at: number
  /** まだ隠れている新しい側の行番号（1 始まり、両端含む）。 */
  from: number
  to: number
  /** まだ隠れている行数（`to - from + 1`）。広げ切ると 0。 */
  count: number
  /** この領域で既に広げてある行数。0 より大きいときだけ畳み直せる。 */
  shown: number
  /** 上に hunk が無い（＝ファイルの先頭）。下へ広げるボタンを出さない。 */
  head: boolean
  /** 下に hunk が無い（＝ファイルの末尾）。上へ広げるボタンを出さない。 */
  tail: boolean
}

export interface Expansion {
  lines: DiffLine[]
  gaps: Gap[]
}

/** 新しい側の行から、左右そろった context 行を作る。 */
function contextLine(text: string, newNum: number, oldNum: number): DiffLine {
  const segments = [{ text, highlight: false }]
  return {
    left: { num: oldNum, segments, type: 'ctx' },
    right: { num: newNum, segments, type: 'ctx' },
  }
}

/**
 * 展開済みの行を差し込んだ結果と、残っている省略領域を返す。**互いに位置がずれるので一度に作る。**
 *
 * `file` が null（まだ取り寄せていない）なら広げられないので、省略領域はすべてそのまま残る。
 * **末尾の領域は行数が取り寄せて初めて分かる**ので、それまでは帯自体を出さない。
 */
export function expandDiff(src: DiffLine[], file: string[] | null, expanded: Map<number, Expanded>): Expansion {
  const lines: DiffLine[] = []
  const gaps: Gap[] = []

  /** 省略領域を「展開済み ＋ 残り ＋ 展開済み」に分けて積む。 */
  const emitGap = (key: number, from: number, to: number, oldFrom: number, ends: { head: boolean; tail: boolean }) => {
    // 追加・削除だけのファイルは片側の開始行が 0 になるので、範囲が壊れていたら何も出さない。
    if (from < 1 || oldFrom < 1 || to < from) return
    const total = to - from + 1
    // 取り寄せる前は広げられないので、全部が残りになる。
    const seen = file ? expanded.get(key) : undefined
    const top = Math.min(seen?.top ?? 0, total)
    const bottom = Math.min(seen?.bottom ?? 0, total - top)
    const at = (n: number) => contextLine(file?.[n - 1] ?? '', n, oldFrom + (n - from))
    for (let n = from; n < from + top; n++) lines.push(at(n))
    // 広げ切って隠れている行が無くなっても、既に広げてあるなら帯は残す（畳み直す入口）。
    const count = total - top - bottom
    if (count > 0 || top + bottom > 0) {
      gaps.push({ key, at: lines.length, from: from + top, to: to - bottom, count, shown: top + bottom, ...ends })
    }
    for (let n = to - bottom + 1; n <= to; n++) lines.push(at(n))
  }

  // 直前の hunk が新側・旧側でどこまで使ったか。
  let newEnd = 0
  let oldEnd = 0
  let seenHunk = false
  for (let i = 0; i < src.length; i++) {
    const h = src[i].hunk
    if (h) {
      emitGap(i, newEnd + 1, h.newStart - 1, oldEnd + 1, { head: !seenHunk, tail: false })
      newEnd = h.newStart + h.newCount - 1
      oldEnd = h.oldStart + h.oldCount - 1
      seenHunk = true
    }
    lines.push(src[i])
  }
  if (file && seenHunk) {
    // 末尾の改行はファイルを 1 行増やさない。
    const last = file.length - (file[file.length - 1] === '' ? 1 : 0)
    emitGap(src.length, newEnd + 1, last, oldEnd + 1, { head: false, tail: true })
  }
  return { lines, gaps }
}

const stripCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s)

/**
 * 取り寄せた全文がこの diff のものか確かめる。**diff タブは開いたあと自動で取り直さない**ので、
 * 開いたままエディタで保存すると行がずれる。context 行は新旧で同じ内容のはずなので、それが
 * 新しい側の行番号どおりに並んでいるかを見れば分かる。確かめずに使うと、行番号だけ付いた空行や
 * 別の場所の内容が「省略されていた行」として無言で混ざる。
 *
 * 改行コードは比べない（`core.autocrlf` を使う環境では diff が LF・作業ツリーが CRLF になる）。
 */
export function matchesDiff(src: DiffLine[], file: string[]): boolean {
  for (const line of src) {
    const n = line.right.num
    if (line.right.type !== 'ctx' || n === null) continue
    const actual = file[n - 1]
    if (actual === undefined) return false
    if (stripCr(actual) !== stripCr(line.right.segments.map((s) => s.text).join(''))) return false
  }
  return true
}
