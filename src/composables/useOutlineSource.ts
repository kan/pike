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

/**
 * A jump requested by clicking an Outline row (#177). The panel scrolls the
 * editor itself via the shared EditorView; this signal lets EditorTab also
 * scroll a visible preview. `slug` is the Markdown heading anchor (dedup-aware),
 * empty for non-heading symbols — EditorTab falls back to a line ratio then.
 * Each click replaces the ref so repeats re-fire the watcher.
 */
export interface OutlineJump {
  tabId: string
  line: number
  slug: string
}

const jumpRequest = shallowRef<OutlineJump | null>(null)

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
      if (jumpRequest.value?.tabId === tabId) jumpRequest.value = null
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

  function requestJump(target: OutlineJump) {
    jumpRequest.value = target
  }

  return { current, set, clear, bumpVersion, updateCaret, caretPosition, scrollPositions, jumpRequest, requestJump }
}
