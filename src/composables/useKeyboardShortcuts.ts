import { onMounted, onUnmounted } from 'vue'
import { useTabStore } from '../stores/tabs'
import { useProjectStore } from '../stores/project'
import { useShortcutsModal } from './useShortcutsModal'

export function useKeyboardShortcuts() {
  const tabStore = useTabStore()
  const projectStore = useProjectStore()
  const shortcutsModal = useShortcutsModal()

  function onKeyDown(e: KeyboardEvent) {
    if (!e.ctrlKey && !e.altKey) return

    // Ctrl+Shift+P: project switcher
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault()
      projectStore.toggleSwitcher()
      return
    }

    // Ctrl+P: quick open file
    if (e.ctrlKey && !e.shiftKey && e.key === 'p') {
      e.preventDefault()
      projectStore.toggleQuickOpen()
      return
    }

    // Don't handle shortcuts when the switcher or quick open is open
    if (projectStore.showSwitcher || projectStore.showQuickOpen) return

    // Ctrl+S: prevent browser save dialog (EditorTab handles save via CodeMirror)
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault()
      return
    }

    // Ctrl+F / Ctrl+H: prevent browser find dialog (CodeMirror search handles it)
    if (e.ctrlKey && (e.key === 'f' || e.key === 'h')) {
      e.preventDefault()
      return
    }

    // Ctrl+W: close active tab
    if (e.ctrlKey && e.key === 'w') {
      if (tabStore.activeTabId) {
        e.preventDefault()
        tabStore.closeTab(tabStore.activeTabId)
      }
      return
    }

    // Ctrl+T: new terminal tab
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault()
      const project = projectStore.currentProject
      tabStore.addTerminalTab(
        project
          ? { cwd: project.root, shell: project.shell }
          : undefined
      )
      return
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      tabStore.cycleTab(e.shiftKey ? 'prev' : 'next')
      return
    }

    // Ctrl+PageDown / Ctrl+PageUp: cycle tabs (VS Code compatible)
    if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault()
      tabStore.cycleTab(e.key === 'PageDown' ? 'next' : 'prev')
      return
    }

    // Ctrl+K: keyboard shortcuts modal
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault()
      shortcutsModal.toggle()
      return
    }

    // Ctrl+,: open settings tab
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault()
      tabStore.addSettingsTab()
      return
    }

    // Alt+H: open Git History (editor tabs only)
    if (e.altKey && e.key === 'h') {
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
