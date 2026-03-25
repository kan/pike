import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  getSearchQuery,
  closeSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search'

// Inline SVG icons (Lucide-based, 16x16)
const ICON = {
  chevronUp: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  chevronDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  replace: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5-4 4 4 4"/><path d="M5 9h10a2 2 0 0 1 2 2v1"/><path d="m15 19 4-4-4-4"/><path d="M19 15H9a2 2 0 0 1-2-2v-1"/></svg>',
  replaceAll: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 3-4 4 4 4"/><path d="M5 7h10a2 2 0 0 1 2 2v1"/><path d="m9 13-4 4 4 4"/><path d="M5 17h10a2 2 0 0 1 2 2v1"/></svg>',
  chevronRight: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  chevronDownSmall: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
}


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
  dom.className = 'cm-search-custom'

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
    btn.className = 'search-toggle-btn' + (active ? ' active' : '')
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
      if (!query.valid) { cachedTotal = 0 } else {
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

  btnCase.addEventListener('click', () => toggleMode(btnCase, () => caseSensitive, v => caseSensitive = v))
  btnRegex.addEventListener('click', () => toggleMode(btnRegex, () => regexp, v => regexp = v))
  btnWord.addEventListener('click', () => toggleMode(btnWord, () => wholeWord, v => wholeWord = v))

  btnPrev.addEventListener('click', () => { findPrevious(view); scheduleMatchInfo() })
  btnNext.addEventListener('click', () => { findNext(view); scheduleMatchInfo() })
  btnClose.addEventListener('click', () => closeSearchPanel(view))

  btnReplaceOne.addEventListener('click', () => { replaceNext(view); scheduleMatchInfo() })
  btnReplaceAllAction.addEventListener('click', () => { replaceAll(view); scheduleMatchInfo() })

  toggleReplaceBtn.addEventListener('click', () => {
    showReplace = !showReplace
    replaceRow.style.display = showReplace ? '' : 'none'
    toggleReplaceBtn.innerHTML = showReplace ? ICON.chevronDownSmall : ICON.chevronRight
    if (showReplace) replaceInput.focus()
  })

  return {
    dom,
    top: true,
    mount() {
      searchInput.focus()
      searchInput.select()
      requestAnimationFrame(() => commitQuery())
    },
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        scheduleMatchInfo()
      }
    },
  }
}

// Export the configured search extension with custom panel
export function editorSearch() {
  return search({ createPanel: createSearchPanel, top: true })
}

export { searchKeymap }
