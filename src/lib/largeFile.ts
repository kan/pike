/**
 * 大きなファイルビューア（#630）の純粋なロジック。行のブロックのキャッシュと、スクロールの計算。
 * 描くのは `components/editor/LargeFileViewer.vue`、行を読むのは Rust の `fs/large.rs`。
 *
 * **スクロールはブラウザのスクロールバーに任せない。** 1,000 万行 × 20px は 2 億 px で、
 * Chromium の要素の高さの上限（約 3,300 万 px）を超えるので、行の高さぶんの器を作る形
 * （CodeMirror の仮想化と同じ）では末尾まで届かない。先頭に見える行（`top`、小数）を自前で持ち、
 * 見えている行だけを描く。`top` は JS の number（float64）なので、1 億行でも 1 行未満の
 * スクロールが丸めで消えない。
 */

/** 1 回に読む行の数。キャッシュもこの単位で持つ。 */
export const BLOCK_LINES = 256

/** キャッシュに置く量の上限（`LineBlock.cost` の合計。文字なら UTF-16 で約 64MB）。 */
export const CACHE_MAX_COST = 32 * 1024 * 1024

/**
 * 1 行・1 ブロックを持つだけでかかる量（文字数に換算）。**文字数だけで数えない**: 空行だけの
 * ブロックが 0 になり、どれだけ溜まっても捨てられない（配列・文字列・Map の項目は残る）。
 */
const LINE_COST = 32
const BLOCK_COST = 1024

export interface LineBlock {
  lines: string[]
  /** 長すぎて切った行（ブロックの中の位置）。 */
  cut: Set<number>
  /** キャッシュの上限に数える量（文字数 + 行とブロックの持ち分）。 */
  cost: number
}

export function makeBlock(lines: string[], cut: number[]): LineBlock {
  let cost = BLOCK_COST + lines.length * LINE_COST
  for (const l of lines) cost += l.length
  return { lines, cut: new Set(cut), cost }
}

/**
 * 行のブロックの LRU。上限は件数ではなく量（`cost`）で決める（1 行が 64KB まであるので、件数で
 * 縛ると長い行のファイルでメモリが読めない）。
 */
export class LineBlockCache {
  private blocks = new Map<number, LineBlock>()
  private cost = 0

  constructor(private readonly maxCost = CACHE_MAX_COST) {}

  get(block: number): LineBlock | undefined {
    const b = this.blocks.get(block)
    if (b) {
      // 使ったものを末尾へ（Map の並びが古い順）。
      this.blocks.delete(block)
      this.blocks.set(block, b)
    }
    return b
  }

  has(block: number): boolean {
    return this.blocks.has(block)
  }

  /** 置く。上限を超えたら古いものから捨てる。`keep` に入っているブロックは捨てない。 */
  set(block: number, data: LineBlock, keep: ReadonlySet<number> = new Set()) {
    const old = this.blocks.get(block)
    if (old) {
      this.cost -= old.cost
      this.blocks.delete(block)
    }
    this.blocks.set(block, data)
    this.cost += data.cost
    for (const [k, b] of this.blocks) {
      if (this.cost <= this.maxCost) break
      if (k === block || keep.has(k)) continue
      this.blocks.delete(k)
      this.cost -= b.cost
    }
  }

  /** `fromLine` を含むブロックから後ろを捨てる（末尾への追記で、最後のブロックが伸びる）。 */
  dropFrom(fromLine: number) {
    const first = Math.floor(fromLine / BLOCK_LINES)
    for (const [k, b] of this.blocks) {
      if (k < first) continue
      this.blocks.delete(k)
      this.cost -= b.cost
    }
  }

  clear() {
    this.blocks.clear()
    this.cost = 0
  }
}

/** 行 `first` から `count` 行を覆うブロックの番号。`total` 行より後ろは含めない。 */
export function blocksFor(first: number, count: number, total: number): number[] {
  const last = Math.min(first + count, total) - 1
  if (last < first) return []
  const out: number[] = []
  for (let b = Math.floor(first / BLOCK_LINES); b <= Math.floor(last / BLOCK_LINES); b++) out.push(b)
  return out
}

/** 先頭に置ける行の最大。最後の行が下端に来る位置。 */
export function maxTop(total: number, rows: number): number {
  return Math.max(0, total - rows)
}

export function clampTop(top: number, total: number, rows: number): number {
  return Math.min(Math.max(0, top), maxTop(total, rows))
}

export interface Thumb {
  /** つまみの高さ（px）。 */
  size: number
  /** つまみの上端（px）。 */
  offset: number
}

/** つまみの最小の高さ（px）。 */
const THUMB_MIN = 24

/**
 * スクロールバーのつまみ。高さは見えている割合だが、`THUMB_MIN` より小さくしない（1,000 万行では
 * 割合どおりだと 1px に満たない）。そのぶん、位置は「動かせる幅」に対する `top` の割合で決める。
 */
export function thumbFor(top: number, total: number, rows: number, track: number): Thumb {
  if (total <= rows || track <= 0) return { size: track, offset: 0 }
  const size = Math.min(track, Math.max(THUMB_MIN, (track * rows) / total))
  const range = maxTop(total, rows)
  return { size, offset: range > 0 ? ((track - size) * top) / range : 0 }
}

/** つまみの上端（px）から `top` を逆算する。 */
export function topFromThumb(offset: number, total: number, rows: number, track: number): number {
  const { size } = thumbFor(0, total, rows, track)
  const free = track - size
  if (free <= 0) return 0
  return clampTop((Math.min(Math.max(0, offset), free) / free) * maxTop(total, rows), total, rows)
}

/**
 * 編集する行の中身をキャッシュから集める。まだ読んでいない行があれば `null`、64KB で切った行
 * （`cut`）があれば `'cut'`（切った行を書き換えると、表示していない後ろが消える）。
 */
export function linesForEdit(cache: LineBlockCache, start: number, count: number): string[] | 'cut' | null {
  const out: string[] = []
  for (let line = start; line < start + count; line++) {
    const block = cache.get(Math.floor(line / BLOCK_LINES))
    const i = line % BLOCK_LINES
    const text = block?.lines[i]
    if (block === undefined || text === undefined) return null
    if (block.cut.has(i)) return 'cut'
    out.push(text)
  }
  return out
}

/** 入力欄の中身を行に分ける。貼り付けた CRLF / CR も改行として扱う。 */
export function splitEditText(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** 行を一致の前・一致・後ろに分ける。範囲が行の外（切った行の後ろ）なら一致を空にする。 */
export function splitAt(text: string, col: number, len: number): [string, string, string] {
  if (col >= text.length) return [text, '', '']
  return [text.slice(0, col), text.slice(col, col + len), text.slice(col + len)]
}
