/**
 * CSV プレビューの列・行の選択（Excel 風）。
 *
 * **ブラウザの文字選択では作れない形なので、選択は自前で持つ。** 文字選択は文書の並びに沿った
 * 1 本の範囲で、表の 1 列だけを選ぶことができない。そこで選んだ列・行をこちらで覚えて印の
 * class を付け、コピーはこちらでタブ区切りに組み立てる（Excel やスプレッドシートにそのまま貼れる）。
 *
 * - 列見出しのクリックで列、行番号（`#` 列）のクリックで行、左上の `#` で全体を選ぶ
 * - Shift+クリックで最後に選んだところから範囲を広げ、Ctrl（⌘）+クリックで 1 つずつ足し引きする
 * - 本文のセルをクリックすると選択を外す（セルの中の文字を普通に選べるように）
 *
 * **選択は描画に焼き込まない**。プレビューは打鍵のたびに `v-html` で作り直されるので、印は
 * `paint` が描画のあとに付け直す（`previewHtml` の watcher から呼ぶ）。何も選んでいなければ
 * `paint` は何もしない（CSV を編集するたびに数万セルを走査しないため）。
 *
 * **列の番号は `#` 列を数えない 0 始まり**（`lib/csvPreview.ts` と同じ）。DOM のセルの位置
 * （`#` 列が 0）から直すのは、DOM を読み書きするこのファイルの `domCol` / `cellAt` だけ。
 */
import { type Ref, watch } from 'vue'
import { type CsvData, type CsvRow, cellsOf } from '../lib/csvPreview'
import { hasMod } from '../lib/keys'
import { joinTsv } from '../lib/text'

type Selection = { kind: 'all' } | { kind: 'rows' | 'cols'; indices: Set<number>; anchor: number }

/** 表の中の 1 セルの位置。行は本文の行（見出しは null）、列は `#` 列を数えない（`#` 列は null）。 */
export interface CsvCellRef {
  row: number | null
  col: number | null
  text: string
}

/** コピーの材料。`rows` は並べ替え済みの全行、`pageOffset` は表示中のページの先頭の位置。 */
export interface CsvSelectionSource {
  data: CsvData | null
  rows: CsvRow[]
  pageOffset: number
}

/** DOM のセルの位置（`#` 列が 0）を列の番号に直す。`#` 列なら null。 */
const domCol = (cellIndex: number) => (cellIndex > 0 ? cellIndex - 1 : null)

/**
 * `source` は、コピーのときに読む表の中身（ページに区切られていない全行）。
 *
 * **コピーは描いた表（DOM）ではなくこちらから組み立てる。** 表はページ送りで 1 ページぶんしか
 * 描いていないが、全体や列を選んだときは全ページぶんをコピーする（プレビューの帯に書いてある）。
 * 行の選択だけはページの中の位置で持つ（行番号をクリックして選ぶのは、見えている行なので）。
 */
export function useCsvSelection(container: Ref<HTMLElement | undefined>, source: () => CsvSelectionSource) {
  // 描画には使わない（印は `paint` が DOM に付ける）ので reactive にしない。
  let selection: Selection | null = null
  /** 今の表に印が付いているか。付いていなければ消す走査を飛ばす。 */
  let painted = false

  // Edit 表示へ切り替えるとプレビューの要素ごと消える。選択を残すと、戻ったときに印の無い
  // 選択が `Ctrl+C` で黙ってコピーされるので、要素が入れ替わったら捨てる。
  watch(container, () => {
    selection = null
    painted = false
  })

  const table = () => container.value?.querySelector('table') ?? null

  /** クリックを受け持ったら true（呼び出し側はほかの処理に回さない）。 */
  function handleClick(e: MouseEvent): boolean {
    const el = e.target as HTMLElement
    const th = el.closest<HTMLTableCellElement>('thead th')
    if (th) {
      const col = domCol(th.cellIndex)
      if (col === null) selectAll()
      else pick('cols', col, e)
      return true
    }
    const rowNum = el.closest<HTMLTableCellElement>('td.csv-row-num')
    if (rowNum) {
      pick('rows', (rowNum.parentElement as HTMLTableRowElement).sectionRowIndex, e)
      return true
    }
    if (selection && el.closest('td')) clear()
    return false
  }

  function pick(kind: 'rows' | 'cols', index: number, e: MouseEvent) {
    const same = selection && selection.kind === kind ? selection : null
    if (same && e.shiftKey) {
      const from = Math.min(same.anchor, index)
      const indices = new Set(Array.from({ length: Math.abs(same.anchor - index) + 1 }, (_, k) => from + k))
      select({ kind, indices, anchor: same.anchor })
    } else if (same && hasMod(e)) {
      const indices = new Set(same.indices)
      if (indices.has(index)) indices.delete(index)
      else indices.add(index)
      select(indices.size > 0 ? { kind, indices, anchor: index } : null)
    } else {
      selectOne(kind, index)
    }
  }

  function selectAll() {
    select({ kind: 'all' })
  }

  /** 行か列を 1 つだけ選ぶ（クリックと右クリックのメニュー）。`null`（その場所に行・列が無い）なら何もしない。 */
  function selectOne(kind: 'rows' | 'cols', index: number | null) {
    if (index !== null) select({ kind, indices: new Set([index]), anchor: index })
  }

  /** 要素が表のどの行・列にあるか。表の外なら行・列とも null。 */
  function locate(el: Element): CsvCellRef {
    const cell = el.closest<HTMLTableCellElement>('td, th')
    if (!cell || !container.value?.contains(cell)) return { row: null, col: null, text: '' }
    const row = cell.parentElement as HTMLTableRowElement
    return {
      row: row.parentElement?.tagName === 'TBODY' ? row.sectionRowIndex : null,
      col: domCol(cell.cellIndex),
      text: cell.textContent ?? '',
    }
  }

  const hasSelection = () => selection !== null

  /** 列・行の見出しから選んだとき。Shift+クリックはブラウザの文字選択も伸ばすので、そちらは消す。 */
  function select(next: Selection | null) {
    selection = next
    window.getSelection()?.removeAllRanges()
    paint()
  }

  /** 選択を外す。セルの中の文字選択は残す（本文のクリックで外すため）。 */
  function clear() {
    selection = null
    paint()
  }

  /** 選択の印を付け直す。描画し直したあとにも呼ぶ。 */
  function paint() {
    if (!selection && !painted) return
    const tbl = table()
    if (!tbl) return
    for (const el of tbl.querySelectorAll('.csv-sel')) el.classList.remove('csv-sel')
    tbl.classList.remove('csv-sel')
    painted = selection !== null
    if (!selection) return
    if (selection.kind === 'all') {
      tbl.classList.add('csv-sel')
    } else if (selection.kind === 'rows') {
      for (const i of selection.indices) tbl.tBodies[0]?.rows[i]?.classList.add('csv-sel')
    } else {
      // DOM のセルは `#` 列のぶん 1 つずれる。
      for (const row of tbl.rows) {
        for (const i of selection.indices) row.cells[i + 1]?.classList.add('csv-sel')
      }
    }
  }

  /** 選んだ範囲をタブ区切りで返す。何も選んでいなければ null。`#` 列（行番号）は含めない。 */
  function selectedText(): string | null {
    const { data, rows, pageOffset } = source()
    if (!selection || !data) return null
    const cells = (row: CsvRow) => cellsOf(row, data.delimiter)
    if (selection.kind === 'rows') {
      const picked = [...selection.indices].sort((a, b) => a - b).flatMap((i) => rows[pageOffset + i] ?? [])
      return joinTsv(picked.map(cells))
    }
    // 全体と列は見出しの行も含めた全ページぶん（Excel で列を選んでコピーしたときと同じ）。
    const table = [data.headers, ...rows.map(cells)]
    if (selection.kind === 'all') return joinTsv(table)
    const cols = [...selection.indices].sort((a, b) => a - b)
    return joinTsv(table.map((r) => cols.map((i) => r[i] ?? '')))
  }

  return { handleClick, clear, paint, selectAll, selectOne, locate, hasSelection, selectedText }
}
