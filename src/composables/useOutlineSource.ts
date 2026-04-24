import type { EditorView } from '@codemirror/view'
import { shallowRef } from 'vue'

export interface OutlineSource {
  tabId: string
  /** File path. Empty string for untitled tabs. */
  path: string
  /** Lowercased file extension (e.g. 'ts', 'rs'). Empty for untitled. */
  langId: string
  /** Live CodeMirror EditorView for syntaxTree access. */
  view: EditorView
  /** Bumped on every doc change. Watchers debounce on this. */
  version: number
}

const current = shallowRef<OutlineSource | null>(null)

/** Per-tab scroll position for the outline panel body. Persists across panel remounts. */
const scrollPositions = new Map<string, number>()

/** Current caret offset in the active outline source. Updates on selection change. */
const caretPosition = shallowRef<{ tabId: string; offset: number } | null>(null)

export function useOutlineSource() {
  function set(src: Omit<OutlineSource, 'version'>) {
    current.value = { ...src, version: 0 }
    const head = src.view.state.selection.main.head
    caretPosition.value = { tabId: src.tabId, offset: head }
  }

  function clear(tabId?: string) {
    if (!tabId || current.value?.tabId === tabId) {
      current.value = null
    }
    if (tabId) {
      scrollPositions.delete(tabId)
      if (caretPosition.value?.tabId === tabId) caretPosition.value = null
    }
  }

  function bumpVersion(tabId: string) {
    if (current.value?.tabId !== tabId) return
    current.value = { ...current.value, version: current.value.version + 1 }
  }

  function updateCaret(tabId: string, offset: number) {
    if (current.value?.tabId !== tabId) return
    const prev = caretPosition.value
    if (prev && prev.tabId === tabId && prev.offset === offset) return
    caretPosition.value = { tabId, offset }
  }

  return { current, set, clear, bumpVersion, updateCaret, caretPosition, scrollPositions }
}
