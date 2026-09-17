/**
 * CSV / TSV プレビューの表（ページ送り・表示件数・並べ替え）。
 *
 * **読み込み・並べ替え・1 ページぶんの HTML を分けてある。** 読み込みは本文が変わったときだけ、
 * 並べ替えは読み込みか並べ方が変わったときだけ、HTML はページを動かすたびに作り直せばよい。
 * 以前は先頭 10,000 行を毎回まとめて HTML にし、それより後ろは表示していなかった。ページ送りに
 * したので打ち切りは無く、描くのは 1 ページぶんだけになった。
 *
 * **行はセルに分けないまま持つ**（`CsvRow.line`）。本文は打鍵が止まるたびに読み直すので、全行を
 * セルに分けると数 MB の CSV で編集が重くなる。セルに分けるのは、描くページの行・並べ替えの列・
 * 全体や列のコピーのときだけ。
 *
 * **列の番号は `#` 列（行番号）を数えない 0 始まりで統一する**（`CsvSort.col`・選択・メニュー）。
 * DOM のセルの位置（`#` 列が 0）から直すのは、DOM を読む境目（`useCsvSelection`）の 1 か所だけ。
 *
 * ページ送りと並べ替えのボタンは `v-html` の中に描き、`data-csv-*` の印でクリックを受ける
 * （EditorTab の `handleCsvControls`）。
 */
import { t } from '../i18n'
import { displayWidth } from './displayWidth'
import { escapeHtml, splitDelimited } from './text'

/**
 * 1 ページの表示件数の選択肢（設定 `csvPageSize`。検証は設定ストアがこれを読んで行う）。
 * 5,000 を超える選択肢を置かないのは、1 ページを描く費用が打鍵のたびに乗るため。全行を読む
 * 費用はこの件数では減らない（行の切り出しは全体に対して走る）。
 */
export const CSV_PAGE_SIZES = [100, 500, 1000, 5000] as const
export const CSV_PAGE_SIZE_DEFAULT = 1000

export interface CsvRow {
  /** ファイルの中での行番号（見出しを除いて 1 から）。並べ替えても変わらない。 */
  num: number
  /** セルに分ける前の 1 行。分けるのは `cellsOf`。 */
  line: string
}

export interface CsvData {
  headers: string[]
  rows: CsvRow[]
  delimiter: string
}

export interface CsvSort {
  /** 並べる列（`#` 列を数えない 0 始まり）。 */
  col: number
  dir: 'asc' | 'desc'
}

/**
 * 行の並びから読む。**本文を 1 本の文字列にしない**（`doc.iterLines()` をそのまま渡せる）。
 * 数十 MB の本文を結合してから正規表現で割ると、打鍵が止まるたびに全文を何度もなめる。
 */
export function parseCsv(lines: Iterable<string>, delimiter: string): CsvData {
  let headers: string[] | null = null
  const rows: CsvRow[] = []
  for (const raw of lines) {
    // CodeMirror は改行を `\n` にそろえて持つが、文字列から渡されたときのために `\r` も落とす。
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) continue
    // RFC 4180 の引用符の扱いは `lib/text.ts` と共有する（rst の `csv-table` も同じ規則）。
    if (headers === null) headers = splitDelimited(line, delimiter)
    else rows.push({ num: rows.length + 1, line })
  }
  return { headers: headers ?? [], rows, delimiter }
}

export function cellsOf(row: CsvRow, delimiter: string): string[] {
  return splitDelimited(row.line, delimiter)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 数として読めるセルは数として比べる（`"10"` が `"9"` より後ろ、`"-1.5"` も数）。 */
function asNumber(s: string): number | null {
  const trimmed = s.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * 並べ替えた新しい配列を返す（元の並びは残す。「元の順に戻す」は並べ替えをやめるだけ）。
 *
 * - **空のセルは向きに関係なく末尾**。降順にしたとたん空行が先頭に集まると、中身が見えない
 * - 数と文字列が混ざる列では、数を先に置く
 * - 同じ値の行は元の順を保つ（`Array.prototype.sort` は安定）
 *
 * 比べる値は先に 1 回だけ取り出す（比べるたびに行をセルに分けない）。
 */
export function sortCsvRows(data: CsvData, sort: CsvSort): CsvRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const keyed = data.rows.map((row) => {
    const text = cellsOf(row, data.delimiter)[sort.col] ?? ''
    return { row, text, empty: text.trim() === '', num: asNumber(text) }
  })
  keyed.sort((a, b) => {
    if (a.empty || b.empty) return (a.empty ? 1 : 0) - (b.empty ? 1 : 0)
    if (a.num !== null && b.num !== null) return (a.num - b.num) * sign
    if (a.num !== null || b.num !== null) return a.num !== null ? -1 : 1
    return collator.compare(a.text, b.text) * sign
  })
  return keyed.map((k) => k.row)
}

/** 並べ替えのボタンを 1 回押したあとの状態（昇順 → 降順 → 元の順）。別の列なら昇順から。 */
export function nextCsvSort(current: CsvSort | null, col: number): CsvSort | null {
  if (current?.col !== col) return { col, dir: 'asc' }
  return current.dir === 'asc' ? { col, dir: 'desc' } : null
}

export interface CsvPageBounds {
  total: number
  pageSize: number
  pageCount: number
  /** 範囲に収めたページ（0 始まり）。 */
  page: number
  /** そのページの先頭が、並べ替えた行の何行目か。 */
  offset: number
}

/** ページ数と、実際に出すページ（範囲に収めたもの）。範囲に収めるのはここ 1 か所だけ。 */
export function csvPageBounds(total: number, page: number, pageSize: number): CsvPageBounds {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(0, page), pageCount - 1)
  return { total, pageSize, pageCount, page: current, offset: current * pageSize }
}

/**
 * 巨大なファイルを先頭から一部だけ読んでいるとき（#362 の部分読み込み）の、表の上の案内。
 * `limitMb` は丸ごと開ける上限（設定）、`loading` は続きを読んでいる最中。
 */
export interface CsvPartialLoad {
  limitMb: number
  loading: boolean
}

/** 表示中のページの HTML。`rows` は並べ替え済みのもの。 */
export function renderCsvPage(
  data: CsvData,
  rows: CsvRow[],
  bounds: CsvPageBounds,
  sort: CsvSort | null,
  partial: CsvPartialLoad | null,
): string {
  if (data.headers.length === 0) return `<p>${escapeHtml(t('csv.empty'))}</p>`

  // 表示件数を切り替える余地が無い（最小の件数に収まる）表には、ページの帯を出さない。
  let html = bounds.total > CSV_PAGE_SIZES[0] ? pager(bounds, true) : ''
  // 部分読み込みの案内はコピーの注意書きの下に置く。**全行と言っているのは読み込んだ範囲の全行**
  // なので、読んでいない続きがあることを同じ場所で言っておく。上部のバーの「続きを読む」は CSV では
  // 出さない（ページの帯と並ぶと、どちらが何を送るのか紛らわしい）ので、入口はここ。
  if (partial) {
    const label = escapeHtml(t(partial.loading ? 'common.loading' : 'editor.loadMore'))
    const disabled = partial.loading ? ' disabled' : ''
    html +=
      `<div class="csv-partial">${escapeHtml(t('csv.partialNotice', { limit: `${partial.limitMb} MB` }))}` +
      `<button type="button" data-csv-load-more${disabled}>${label}</button></div>`
  }
  html += '<table><thead><tr><th>#</th>'
  data.headers.forEach((h, i) => {
    const dir = sort?.col === i ? sort.dir : ''
    // 向きの記号は CSS の `::after` で描く。文字として入れると、見出しのセルの中身（コピー）に混ざる。
    const title = escapeHtml(t(dir === 'asc' ? 'csv.sortDesc' : dir === 'desc' ? 'csv.sortReset' : 'csv.sortAsc'))
    html += `<th><span class="csv-th-label">${escapeHtml(h)}</span><button type="button" class="csv-sort" data-csv-sort="${i}" data-dir="${dir}" title="${title}"></button></th>`
  })
  html += '</tr></thead><tbody>'
  for (const row of rows.slice(bounds.offset, bounds.offset + bounds.pageSize)) {
    html += `<tr><td class="csv-row-num">${row.num}</td>`
    for (const c of cellsOf(row, data.delimiter)) html += `<td>${escapeHtml(c)}</td>`
    html += '</tr>'
  }
  html += '</tbody></table>'
  // 下にも置く（下までスクロールしたところから次のページへ行けるように）。
  if (bounds.pageCount > 1) html += pager(bounds, false)
  return html
}

function pager(b: CsvPageBounds, withHint: boolean): string {
  const first = b.page === 0 ? ' disabled' : ''
  const last = b.page === b.pageCount - 1 ? ' disabled' : ''
  const rangeText = (from: number, to: number) =>
    t('csv.pageRange', { from: from.toLocaleString(), to: to.toLocaleString(), total: b.total.toLocaleString() })
  const range = rangeText(b.total === 0 ? 0 : b.offset + 1, Math.min(b.offset + b.pageSize, b.total))
  // **いちばん長くなる表記ぶんの幅を先に取る。** ページを送るたびに桁数が変わると、帯の右側
  // （次へのボタン・表示件数）が横にずれて、続けて押そうとした位置からボタンが逃げる。
  // 数字は `tabular-nums` で等幅にしてあるので、表示幅（全角を 2）を `ch` に当てれば足りる。
  const rangeWidth = displayWidth(rangeText(b.total, b.total))
  const sizes = CSV_PAGE_SIZES.map(
    (n) => `<option value="${n}"${n === b.pageSize ? ' selected' : ''}>${n.toLocaleString()}</option>`,
  ).join('')
  const button = (to: string, label: string, title: string, disabled: string) =>
    `<button type="button" data-csv-page="${to}" title="${escapeHtml(t(title))}"${disabled}>${label}</button>`
  return (
    `<div class="csv-pager">` +
    button('first', '«', 'csv.pageFirst', first) +
    button('prev', '‹', 'csv.pagePrev', first) +
    `<span class="csv-pager-info" style="min-width:${rangeWidth}ch">${escapeHtml(range)}</span>` +
    button('next', '›', 'csv.pageNext', last) +
    button('last', '»', 'csv.pageLast', last) +
    `<label class="csv-pager-size">${escapeHtml(t('csv.pageSize'))}<select data-csv-page-size>${sizes}</select></label>` +
    // 選択のコピーの範囲はページで区切らない（`useCsvSelection` の `selectedText`）。見えている範囲と
    // コピーされる範囲が食い違うので、ページが複数あるときは帯の上で言っておく。
    (withHint && b.pageCount > 1
      ? `<span class="csv-pager-hint">${escapeHtml(t('csv.copyAllPagesHint'))}</span>`
      : '') +
    `</div>`
  )
}
