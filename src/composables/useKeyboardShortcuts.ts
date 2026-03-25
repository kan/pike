import { onMounted, onUnmounted } from 'vue'
import { useTabStore } from '../stores/tabs'
import { useProjectStore } from '../stores/project'

export function useKeyboardShortcuts() {
  const tabStore = useTabStore()
  const projectStore = useProjectStore()

  function onKeyDown(e: KeyboardEvent) {
    // Ctrl+Shift+P: project switcher
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault()
      projectStore.toggleSwitcher()
      return
    }

    // Don't handle shortcuts when the switcher is open
    if (projectStore.showSwitcher) return

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
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
