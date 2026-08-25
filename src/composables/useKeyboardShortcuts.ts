import { onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import { useShortcutsModal } from './useShortcutsModal'

/**
 * `e.key` for comparison against lowercase literals. Caps Lock inverts the case
 * of letter keys, so matching `'p'` directly drops the shortcut while it is on —
 * every handler that compares a printable key goes through this.
 */
export function normalizedKey(e: KeyboardEvent): string {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

/**
 * ターミナルにフォーカスがあっても Pike が処理する Ctrl+キー（#224）。
 *
 * 既定はシェル優先である。xterm は PTY へ送るキーで `preventDefault` だけでなく
 * **`stopPropagation` も呼ぶ**（`cancel(ev, true)`）ので、下のハンドラには Ctrl+英字も
 * Tab も PageUp/Down も F1 も届かない。`TerminalTab.vue` の
 * `attachCustomKeyEventHandler` がこの一覧のキーだけ `false` を返して xterm に
 * 処理させず、window まで通している。
 *
 * 中身はタブの出し入れ（閉じる・新規・切替）に絞ってある。readline が使う
 * `Ctrl+K`（行末まで削除）・`Ctrl+P` / `Ctrl+N`（履歴）はシェルのまま。
 * 一覧を変えたら `KeyboardShortcuts.vue` と `docs/manual/shortcuts-and-cli.md` も揃える。
 */
export const PIKE_FIRST_CTRL_KEYS = new Set(['w', 't', 'Tab', 'PageUp', 'PageDown'])

/**
 * 上のうち、全画面 TUI が代替画面を持っているあいだはシェルへ返すもの（#224）。
 * `Ctrl+W` は vim のウィンドウ操作の prefix なので、vim を開いているあいだ Pike が
 * 奪うと `Ctrl+W s` などが一切打てず、しかもタブが閉じる。素のシェル（readline の
 * unix-werase）では Pike 優先のままにするので、判定は代替画面の有無で行う。
 * `Ctrl+T` やタブ切替は全画面 TUI での用途が薄いのでここには入れない。
 */
export const ALT_SCREEN_SHELL_KEYS = new Set(['w'])

export function useKeyboardShortcuts() {
  const tabStore = useTabStore()
  const projectStore = useProjectStore()
  const shortcutsModal = useShortcutsModal()

  function onKeyDown(e: KeyboardEvent) {
    const key = normalizedKey(e)
    // Block the WebView reload accelerators (Ctrl+R, Ctrl+Shift+R, F5). A stray
    // reload tears down every PTY/terminal session, which looks like an app
    // restart (issue #96). Vite HMR still reloads on file change during dev.
    if ((e.ctrlKey && key === 'r') || key === 'F5') {
      e.preventDefault()
      return
    }

    // F1: open the user manual
    if (key === 'F1') {
      e.preventDefault()
      tabStore.addManualTab()
      return
    }

    if (!e.ctrlKey && !e.altKey) return

    // Ctrl+Shift+P: project switcher
    if (e.ctrlKey && e.shiftKey && key === 'p') {
      e.preventDefault()
      projectStore.toggleSwitcher()
      return
    }

    // Ctrl+P: quick open file
    if (e.ctrlKey && !e.shiftKey && key === 'p') {
      e.preventDefault()
      projectStore.toggleQuickOpen()
      return
    }

    // Don't handle shortcuts when the switcher or quick open is open
    if (projectStore.showSwitcher || projectStore.showQuickOpen) return

    // Ctrl+S: prevent browser save dialog (EditorTab handles save via CodeMirror)
    if (e.ctrlKey && key === 's') {
      e.preventDefault()
      return
    }

    // Ctrl+F / Ctrl+H: prevent browser find dialog. The active view handles the
    // shortcut itself (CodeMirror in the editor, a window listener in DiffTab).
    if (e.ctrlKey && (key === 'f' || key === 'h')) {
      e.preventDefault()
      return
    }

    // Ctrl+W: close active tab
    if (e.ctrlKey && key === 'w') {
      if (tabStore.activeTabId) {
        e.preventDefault()
        tabStore.closeTab(tabStore.activeTabId)
      }
      return
    }

    // Ctrl+N: new blank editor tab
    if (e.ctrlKey && key === 'n') {
      e.preventDefault()
      tabStore.addBlankEditorTab()
      return
    }

    // Ctrl+T: new terminal tab
    if (e.ctrlKey && key === 't') {
      e.preventDefault()
      const project = projectStore.currentProject
      tabStore.addTerminalTab(project ? { cwd: project.root, shell: project.shell } : undefined)
      return
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
    if (e.ctrlKey && key === 'Tab') {
      e.preventDefault()
      tabStore.cycleTab(e.shiftKey ? 'prev' : 'next')
      return
    }

    // Ctrl+PageDown / Ctrl+PageUp: cycle tabs (VS Code compatible)
    if (e.ctrlKey && (key === 'PageDown' || key === 'PageUp')) {
      e.preventDefault()
      tabStore.cycleTab(key === 'PageDown' ? 'next' : 'prev')
      return
    }

    // Ctrl+K: keyboard shortcuts modal.
    // Not while a Markdown editor has focus: `markdownAssistKeymap` (#241) binds
    // it to link insertion with `stopPropagation`, so the key never reaches here.
    // Anything else bound to Ctrl+B / Ctrl+I / Ctrl+K below would be silently
    // dead in that one place — the same trap `PIKE_FIRST_CTRL_KEYS` documents
    // for the terminal.
    if (e.ctrlKey && key === 'k') {
      e.preventDefault()
      shortcutsModal.toggle()
      return
    }

    // Ctrl+,: open settings tab
    if (e.ctrlKey && key === ',') {
      e.preventDefault()
      tabStore.addSettingsTab()
      return
    }

    // Alt+H: open Git History (editor tabs only)
    if (e.altKey && key === 'h') {
      const active = tabStore.activeTab
      if (active?.kind === 'editor') {
        e.preventDefault()
        tabStore.addHistoryTab({ filePath: active.path })
      }
      return
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
