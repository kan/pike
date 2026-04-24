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

export function useOutlineSource() {
  function set(src: Omit<OutlineSource, 'version'>) {
    current.value = { ...src, version: 0 }
  }

  function clear(tabId?: string) {
    if (!tabId || current.value?.tabId === tabId) {
      current.value = null
    }
  }

  function bumpVersion(tabId: string) {
    if (current.value?.tabId !== tabId) return
    current.value = { ...current.value, version: current.value.version + 1 }
  }

  return { current, set, clear, bumpVersion }
}
