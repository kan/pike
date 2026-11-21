/**
 * CSV / TSV の表（ページ送り・表示件数・並べ替え・列と行の選択）の状態と操作。
 *
 * **エディタの CSV プレビューと DB ビューワ（#632）が共有する。** 表の中身（`CsvData`）を
 * どこから読むかだけが違うので、読み方は呼び出し側が `data` で渡し、それより後ろ（並べ替え・
 * ページ・描画・ページ送りのボタン・選択とコピー）はここに 1 つだけ置く。判断の実体は
 * `lib/csvPreview.ts`（描画）と `useCsvSelection.ts`（選択）。見た目は `assets/csvTable.css`
 * （表の器に `csv-preview` の class を付ける）。
 */
import { computed, nextTick, type Ref, ref, watch } from 'vue'
import {
  type CsvData,
  type CsvPartialLoad,
  type CsvSort,
  csvPageBounds,
  nextCsvSort,
  renderCsvPage,
  sortCsvRows,
} from '../lib/csvPreview'
import { matchChord } from '../lib/keys'
import { useSettingsStore } from '../stores/settings'
import { useCsvSelection } from './useCsvSelection'
import '../assets/csvTable.css'

/**
 * **`data` と `partial` は、この composable を呼んだその場で評価される**（表の HTML を watch する
 * ため）。中で読む値は呼び出しより前に定義しておくこと。後ろの `const` を読むと TDZ の
 * `ReferenceError` で呼び出し側の setup ごと落ちる。
 */
export interface CsvTableOptions {
  /** 表を描く器（`v-html` の要素）。 */
  container: Ref<HTMLElement | undefined>
  /** 表の中身。null なら表を描かない。 */
  data: () => CsvData | null
  /** 表を出しているか（エディタは CSV 以外のファイルでもこの composable を持つ）。既定は常に true。 */
  active?: () => boolean
  /** 部分読み込みの案内（エディタだけ）。null なら出さない。 */
  partial?: () => CsvPartialLoad | null
  /** 部分読み込みの「続きを読む」（エディタだけ）。 */
  onLoadMore?: () => void
}

export function useCsvTable(opts: CsvTableOptions) {
  const settingsStore = useSettingsStore()
  const active = opts.active ?? (() => true)

  /** 表示中のページ（0 始まり）。範囲外は描くときに寄せる。 */
  const page = ref(0)
  /** 並べ替え。null なら元の順。表ごとに持ち、保存しない。 */
  const sort = ref<CsvSort | null>(null)

  /** 並べ替えを当てた行。選択のコピーもこの並びで組み立てる。 */
  const rows = computed(() => {
    const data = opts.data()
    if (!data) return []
    const s = sort.value
    return s && s.col < data.headers.length ? sortCsvRows(data, s) : data.rows
  })

  /** 表示するページ（範囲に収めたもの）。描画・ページ送り・行の選択のコピーが同じ値を読む。 */
  const bounds = computed(() => csvPageBounds(rows.value.length, page.value, settingsStore.csvPageSize))

  /** 列・行の選択（Excel 風）。 */
  const selection = useCsvSelection(opts.container, () => ({
    data: opts.data(),
    rows: rows.value,
    pageOffset: bounds.value.offset,
  }))

  // ページ・並べ方・件数が変わると、ページの中の位置で持っている選択は別の行を指す。
  watch([page, sort, () => settingsStore.csvPageSize], () => {
    if (!active()) return
    selection.clear()
    opts.container.value?.scrollTo({ top: 0 })
  })

  // 表示件数は全タブ共通の設定なので、どのタブで変えてもここに届く。**ページも先頭に戻す**:
  // 件数が変わると同じページ番号が別の行を指し、ほかのタブが黙って別の場所を出すことになる。
  watch(
    () => settingsStore.csvPageSize,
    () => {
      page.value = 0
    },
  )

  /** 並べ方を変えて先頭のページへ戻る（並べ替えたあとに途中のページを見ていても意味が無い）。 */
  function setSort(next: CsvSort | null) {
    sort.value = next
    page.value = 0
  }

  /** 表示中のページの HTML（`v-html` に渡す）。 */
  const html = computed(() => {
    const data = opts.data()
    return data ? renderCsvPage(data, rows.value, bounds.value, sort.value, opts.partial?.() ?? null) : ''
  })

  // 選択の印は描画に焼き込んでいないので、作り直された表に付け直す。
  watch(html, () => {
    if (active()) void nextTick(selection.paint)
  })

  /**
   * 表に描いた操作（並べ替えのボタンとページ送り）。受け持ったら true。
   * 見出しのクリックは列の選択なので、見出しの中の並べ替えボタンはそれより先に受ける。
   */
  function handleControls(e: MouseEvent): boolean {
    const el = e.target as HTMLElement
    const sortBtn = el.closest<HTMLElement>('[data-csv-sort]')
    if (sortBtn) {
      setSort(nextCsvSort(sort.value, Number(sortBtn.dataset.csvSort)))
      return true
    }
    if (el.closest('[data-csv-load-more]')) {
      opts.onLoadMore?.()
      return true
    }
    const pageBtn = el.closest<HTMLButtonElement>('[data-csv-page]')
    if (pageBtn) {
      // 範囲に収めるのは `csvPageBounds`（描くときに寄せる）。端のボタンは押せない。
      const { pageCount, page: current } = bounds.value
      const to = { first: 0, prev: current - 1, next: current + 1, last: pageCount - 1 }[pageBtn.dataset.csvPage ?? '']
      if (to !== undefined) page.value = to
      return true
    }
    // 表示件数の選択はクリックでは何もしない（`change` で受ける）。列の選択に回さない。
    return !!el.closest('.csv-pager')
  }

  /** 表のクリック。ページ送り・並べ替え・選択のどれかが受け持ったら true。 */
  function handleClick(e: MouseEvent): boolean {
    return handleControls(e) || selection.handleClick(e)
  }

  /** 表の上の表示件数の選択。設定に書くので、ほかの表と次に開く表にも効く。 */
  function handleChange(e: Event) {
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-csv-page-size]')
    if (!select) return
    settingsStore.csvPageSize = Number(select.value)
  }

  /**
   * 表にフォーカスがあるときのキー（列・行の選択）。器は `tabindex="-1"` でクリックすると
   * フォーカスを持つので、器の `@keydown` で受ければ「どこに向いたキーか」を推測しなくてよい。
   * **`Ctrl+A` の既定（ペインの中の文字をすべて選ぶ）は `useKeyboardShortcuts` が持つ**。ここで
   * `preventDefault` すると、あちらは表の選択を優先して何もしない。
   */
  function handleKeydown(e: KeyboardEvent, copy: (text: string) => void) {
    if (matchChord(e, 'Mod+A')) {
      e.preventDefault()
      selection.selectAll()
    } else if (matchChord(e, 'Mod+C')) {
      // 列・行を選んでいないときは、セルの中の文字選択を普通にコピーさせる。
      const text = selection.selectedText()
      if (text === null) return
      e.preventDefault()
      copy(text)
    } else if (e.key === 'Escape') {
      selection.clear()
    }
  }

  return { sort, selection, setSort, html, handleClick, handleChange, handleKeydown }
}
