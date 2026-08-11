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

    // Ctrl+K: keyboard shortcuts modal
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
