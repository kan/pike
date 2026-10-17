import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search'
import { StateEffect } from '@codemirror/state'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

// Inline SVG icons (Lucide-based, 16x16)
const ICON = {
  chevronUp:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  chevronDown:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  replace:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5-4 4 4 4"/><path d="M5 9h10a2 2 0 0 1 2 2v1"/><path d="m15 19 4-4-4-4"/><path d="M19 15H9a2 2 0 0 1-2-2v-1"/></svg>',
  replaceAll:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 3-4 4 4 4"/><path d="M5 7h10a2 2 0 0 1 2 2v1"/><path d="m9 13-4 4 4 4"/><path d="M5 17h10a2 2 0 0 1 2 2v1"/></svg>',
  chevronRight:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  chevronDownSmall:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
}

/** Expand the replace row of an already-open panel (what `Ctrl+H` sends). */
const revealReplace = StateEffect.define<null>()

/** 本文の上の余白の既定値（base theme の `.cm-content` の `padding: 4px 0` と同じ）。 */
const CONTENT_PAD_TOP = 4
/** パネルの下端と本文の 1 行目のあいだに空ける隙間。 */
const PANEL_GAP = 4
const SPACE_VAR = '--search-panel-space'

/** 開いている検索パネルが本文の上端を覆っている高さ（view ごと。閉じていれば無い）。 */
const panelCover = new WeakMap<EditorView, number>()

/**
 * 検索パネルが開いているあいだ、本文の上の余白をパネルの下端まで広げる（#480）。
 *
 * パネルは本文の上に浮かせている（`.cm-search-custom` の `position: absolute`）ので、
 * CodeMirror の上部パネルの器は高さを持たず、本文が押し下げられない。そのままだと先頭まで
 * スクロールしても 1 行目がパネルの裏に隠れる。VS Code の検索ウィジェットと同じく、
 * 文書の先頭に余白を足して避ける（スクロールすれば本文はパネルの下を通る）。
 *
 * **高さは実測する。** 置換の行を開くと高くなり、コンフリクトの解消バーのような別の上部
 * パネルが出ていると、本文の上端（scroller）がそのぶん下がって覆う高さが減る。
 * 本文の余白を変えてもパネルと scroller の大きさは動かないので、測り直しはループしない。
 *
 * **先頭から離れているときは、余白の増減と同じだけスクロール位置をずらす。** ずらさないと
 * 開閉のたびに見えている本文が余白のぶん上下に跳ねる（CodeMirror のスクロールの固定は
 * 行の位置で数えるので、padding の変化を補わない）。先頭にいるときだけ本文を押し下げる。
 */
function trackPanelCover(view: EditorView, dom: HTMLElement): () => void {
  let space = CONTENT_PAD_TOP
  const apply = (cover: number | null) => {
    if (cover === null) panelCover.delete(view)
    else panelCover.set(view, cover)
    // 整数にする。CodeMirror は padding を `parseInt` で読む（`documentPadding`）ので、
    // 小数のままだと描かれた位置と測った位置がずれ、クリックや行番号が 1px 未満ずれる。
    const next = cover === null ? CONTENT_PAD_TOP : Math.max(CONTENT_PAD_TOP, cover + PANEL_GAP)
    if (next === space) return
    const scroller = view.scrollDOM
    const atTop = scroller.scrollTop === 0
    if (cover === null) view.dom.style.removeProperty(SPACE_VAR)
    else view.dom.style.setProperty(SPACE_VAR, `${next}px`)
    if (!atTop) scroller.scrollTop += next - space
    space = next
    // 行番号の位置も CodeMirror が測った padding に従うので、測り直させる。
    view.requestMeasure()
  }
  const measure = () => {
    const panel = dom.getBoundingClientRect()
    // タブが `v-show` で隠れているあいだは 0 で届く。見えたときは大きさが 0 から変わるので
    // もう一度届く。
    if (panel.height === 0) return
    apply(Math.max(0, Math.ceil(panel.bottom - view.scrollDOM.getBoundingClientRect().top)))
  }
  // 開いた直後のフレームから効かせる（ResizeObserver の初回は非同期で、`mount()` の直後に
  // 走る検索のスクロールに間に合わない）。`mount()` の時点でパネルは DOM にある。
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(dom)
  observer.observe(view.scrollDOM)
  return () => {
    observer.disconnect()
    apply(null)
  }
}

// **本文の上の余白はこの規則が常に持つ**（パネルが閉じていれば base theme と同じ 4px）。
// 開いているあいだだけ効く class にしないのは、`.cm-editor` の class を CodeMirror が
// 書き直すため。テーマで `.cm-content` の上の余白を変えるときは `CONTENT_PAD_TOP` も直す。
const panelSpace = [
  EditorView.theme({
    '.cm-content': { paddingTop: `var(${SPACE_VAR}, ${CONTENT_PAD_TOP}px)` },
  }),
  // 「次の一致」へ飛んだ先がパネルの裏に入らないよう、スクロールで見せる範囲からも外す。
  EditorView.scrollMargins.of((view) => {
    const cover = panelCover.get(view)
    return cover ? { top: cover + PANEL_GAP } : null
  }),
]

function createSearchPanel(view: EditorView): Panel {
  let showReplace = false
  let searchTerm = ''
  let replaceTerm = ''
  let caseSensitive = false
  let regexp = false
  let wholeWord = false

  // Restore state from existing query
  const existing = getSearchQuery(view.state)
  if (existing.valid) {
    searchTerm = existing.search
    replaceTerm = existing.replace
    caseSensitive = existing.caseSensitive
    regexp = existing.regexp
    wholeWord = existing.wholeWord
  }

  // --- DOM construction ---
  const dom = document.createElement('div')
  // popup-surface keeps the panel opaque under window transparency (issue #162).
  dom.className = 'cm-search-custom popup-surface'

  // Search row
  const searchRow = document.createElement('div')
  searchRow.className = 'search-row'

  const toggleReplaceBtn = document.createElement('button')
  toggleReplaceBtn.className = 'search-icon-btn toggle-replace'
  toggleReplaceBtn.innerHTML = ICON.chevronRight
  toggleReplaceBtn.title = 'Toggle Replace'

  const searchInput = document.createElement('input')
  searchInput.className = 'search-field'
  searchInput.type = 'text'
  searchInput.placeholder = 'Search'
  searchInput.spellcheck = false
  searchInput.value = searchTerm

  // Mode toggles
  const btnCase = createToggle('Aa', 'Match Case', caseSensitive)
  const btnRegex = createToggle('.*', 'Use Regex', regexp)
  const btnWord = createToggle('ab', 'Match Whole Word', wholeWord)
  btnWord.style.textDecoration = 'underline'

  const matchInfo = document.createElement('span')
  matchInfo.className = 'search-match-info'

  const btnPrev = createIconBtn(ICON.chevronUp, 'Previous Match')
  const btnNext = createIconBtn(ICON.chevronDown, 'Next Match')
  const btnClose = createIconBtn(ICON.x, 'Close')
  btnClose.className += ' search-close-btn'

  searchRow.append(toggleReplaceBtn, searchInput, btnCase, btnRegex, btnWord, matchInfo, btnPrev, btnNext, btnClose)

  // Replace row
  const replaceRow = document.createElement('div')
  replaceRow.className = 'replace-row'
  replaceRow.style.display = 'none'

  const replaceInput = document.createElement('input')
  replaceInput.className = 'search-field'
  replaceInput.type = 'text'
  replaceInput.placeholder = 'Replace'
  replaceInput.spellcheck = false
  replaceInput.value = replaceTerm

  const btnReplaceOne = createIconBtn(ICON.replace, 'Replace')
  const btnReplaceAllAction = createIconBtn(ICON.replaceAll, 'Replace All')

  replaceRow.append(replaceInput, btnReplaceOne, btnReplaceAllAction)

  dom.append(searchRow, replaceRow)

  // --- Helpers ---
  function createToggle(label: string, title: string, active: boolean): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = `search-toggle-btn${active ? ' active' : ''}`
    btn.textContent = label
    btn.title = title
    return btn
  }

  function createIconBtn(icon: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'search-icon-btn'
    btn.innerHTML = icon
    btn.title = title
    return btn
  }

  let cachedTotal = 0
  let cachedDocVersion = -1
  let cachedQueryStr = ''
  let matchInfoTimer: ReturnType<typeof setTimeout> | null = null

  function commitQuery() {
    const q = new SearchQuery({
      search: searchInput.value,
      replace: replaceInput.value,
      caseSensitive,
      regexp,
      wholeWord,
    })
    view.dispatch({ effects: setSearchQuery.of(q) })
    // Invalidate cache since query changed
    cachedQueryStr = ''
    scheduleMatchInfo()
  }

  function scheduleMatchInfo() {
    if (matchInfoTimer) clearTimeout(matchInfoTimer)
    matchInfoTimer = setTimeout(updateMatchInfo, 50)
  }

  function updateMatchInfo() {
    const docVersion = view.state.doc.length
    const queryStr = searchInput.value
    if (!queryStr) {
      matchInfo.textContent = ''
      cachedTotal = 0
      return
    }
    // Recount total only when doc or query changed
    if (docVersion !== cachedDocVersion || queryStr !== cachedQueryStr) {
      cachedDocVersion = docVersion
      cachedQueryStr = queryStr
      const query = getSearchQuery(view.state)
      if (!query.valid) {
        cachedTotal = 0
      } else {
        let total = 0
        const cursor = query.getCursor(view.state.doc)
        while (!cursor.next().done) total++
        cachedTotal = total
      }
    }
    if (cachedTotal === 0) {
      matchInfo.textContent = 'No results'
      return
    }
    // Find current match index (cheap — iterates only up to cursor position)
    const query = getSearchQuery(view.state)
    const sel = view.state.selection.main
    let current = 0
    if (query.valid) {
      let idx = 0
      const cursor = query.getCursor(view.state.doc)
      let result = cursor.next()
      while (!result.done) {
        idx++
        if (result.value.from === sel.from && result.value.to === sel.to) {
          current = idx
          break
        }
        if (result.value.from > sel.from) break
        result = cursor.next()
      }
    }
    matchInfo.textContent = current > 0 ? `${current} of ${cachedTotal}` : `${cachedTotal} results`
  }

  function toggleMode(btn: HTMLButtonElement, getter: () => boolean, setter: (v: boolean) => void) {
    const newVal = !getter()
    setter(newVal)
    btn.classList.toggle('active', newVal)
    commitQuery()
  }

  // --- Events ---
  searchInput.addEventListener('input', commitQuery)
  replaceInput.addEventListener('input', commitQuery)

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
      scheduleMatchInfo()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
    }
  })

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      replaceNext(view)
      scheduleMatchInfo()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
    }
  })

  btnCase.addEventListener('click', () =>
    toggleMode(
      btnCase,
      () => caseSensitive,
      (v) => (caseSensitive = v),
    ),
  )
  btnRegex.addEventListener('click', () =>
    toggleMode(
      btnRegex,
      () => regexp,
      (v) => (regexp = v),
    ),
  )
  btnWord.addEventListener('click', () =>
    toggleMode(
      btnWord,
      () => wholeWord,
      (v) => (wholeWord = v),
    ),
  )

  btnPrev.addEventListener('click', () => {
    findPrevious(view)
    scheduleMatchInfo()
  })
  btnNext.addEventListener('click', () => {
    findNext(view)
    scheduleMatchInfo()
  })
  btnClose.addEventListener('click', () => closeSearchPanel(view))

  btnReplaceOne.addEventListener('click', () => {
    replaceNext(view)
    scheduleMatchInfo()
  })
  btnReplaceAllAction.addEventListener('click', () => {
    replaceAll(view)
    scheduleMatchInfo()
  })

  const setReplace = (on: boolean) => {
    showReplace = on
    replaceRow.style.display = on ? '' : 'none'
    toggleReplaceBtn.innerHTML = on ? ICON.chevronDownSmall : ICON.chevronRight
    if (on) replaceInput.focus()
  }
  toggleReplaceBtn.addEventListener('click', () => setReplace(!showReplace))

  let untrackCover: (() => void) | null = null

  return {
    dom,
    top: true,
    mount() {
      untrackCover = trackPanelCover(view, dom)
      searchInput.focus()
      searchInput.select()
      requestAnimationFrame(() => commitQuery())
    },
    destroy() {
      untrackCover?.()
      if (matchInfoTimer) clearTimeout(matchInfoTimer)
    },
    update(update: ViewUpdate) {
      if (update.transactions.some((tr) => tr.effects.some((e) => e.is(revealReplace)))) {
        setReplace(true)
      }
      if (update.selectionSet || update.docChanged) {
        scheduleMatchInfo()
      }
    },
  }
}

// Export the configured search extension with custom panel
export function editorSearch() {
  return [search({ createPanel: createSearchPanel, top: true }), panelSpace]
}

/**
 * 置換行を開いた状態で検索パネルを出す。
 *
 * 置換自体は前から chevron で開けたが、ショートカット一覧とマニュアルが載せていたキーは
 * どこにも割り当てられておらず（`searchKeymap` に `Mod-h` は無い）、押しても何も起きなかった。
 * **キーはここでは決めない**（プリセットで変わる。`lib/editorPresetKeys.ts`）。
 */
export function openReplace(view: EditorView) {
  openSearchPanel(view)
  view.dispatch({ effects: revealReplace.of(null) })
}

export { searchKeymap }
