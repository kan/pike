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
 */
import { type Ref, watch } from 'vue'
import { hasMod } from '../lib/keys'
import { joinTsv } from '../lib/text'

type Selection = { kind: 'all' } | { kind: 'rows' | 'cols'; indices: Set<number>; anchor: number }

/** 表の中の 1 セルの位置。行は本文の行（見出しは null）、列は `#` 列を除く（`#` 列は null）。 */
export interface CsvCellRef {
  row: number | null
  col: number | null
  text: string
}

export function useCsvSelection(container: Ref<HTMLElement | undefined>) {
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
      if (th.cellIndex === 0) selectAll()
      else pick('cols', th.cellIndex, e)
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
      col: cell.cellIndex > 0 ? cell.cellIndex : null,
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
      for (const row of tbl.rows) {
        for (const i of selection.indices) row.cells[i]?.classList.add('csv-sel')
      }
    }
  }

  /** 選んだ範囲をタブ区切りで返す。何も選んでいなければ null。`#` 列は含めない。 */
  function selectedText(): string | null {
    const tbl = table()
    if (!tbl || !selection) return null
    const sorted = selection.kind === 'all' ? [] : [...selection.indices].sort((a, b) => a - b)
    // 行: 全体と列は見出しを含む全行（Excel で列を選んでコピーしたときと同じ）、行は選んだ本文の行。
    const rows = selection.kind === 'rows' ? sorted.flatMap((i) => tbl.tBodies[0]?.rows[i] ?? []) : [...tbl.rows]
    // 列: 列を選んだときはその列、ほかは `#` 列を除いた全部。
    const cols = (row: HTMLTableRowElement) =>
      selection?.kind === 'cols' ? sorted : Array.from({ length: row.cells.length - 1 }, (_, k) => k + 1)
    return joinTsv(rows.map((row) => cols(row).map((i) => row.cells[i]?.textContent ?? '')))
  }

  return { handleClick, clear, paint, selectAll, selectOne, locate, hasSelection, selectedText }
}
