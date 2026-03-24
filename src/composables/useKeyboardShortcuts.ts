import { onMounted, onUnmounted } from 'vue'
import { useTabStore } from '../stores/tabs'

export function useKeyboardShortcuts() {
  const tabStore = useTabStore()

  function onKeyDown(e: KeyboardEvent) {
    // Ctrl+W: close active tab (pinned tabs are protected by store)
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
      tabStore.addTerminalTab()
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
