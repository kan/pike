import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { TerminalTab } from '../types/tab'
import { ptyRouter } from './usePtyRouter'

type NotifyFn = (title: string, body: string, onClick?: () => void) => void

async function resolveNotifier(): Promise<NotifyFn | null> {
  // Try Web Notification API
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      return (title, body, onClick) => {
        const n = new Notification(title, { body })
        if (onClick)
          n.onclick = () => {
            onClick()
            n.close()
          }
      }
    }
    if (Notification.permission !== 'denied') {
      const result = await Notification.requestPermission()
      if (result === 'granted') {
        return (title, body, onClick) => {
          const n = new Notification(title, { body })
          if (onClick)
            n.onclick = () => {
              onClick()
              n.close()
            }
        }
      }
    }
  }
  // Fallback to Tauri plugin (no click support)
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
    let permitted = await isPermissionGranted()
    if (!permitted) {
      const perm = await requestPermission()
      permitted = perm === 'granted'
    }
    if (permitted) {
      return (title, body) => sendNotification({ title, body })
    }
  } catch {
    // plugin not available
  }
  return null
}

export async function initTerminalNotifications() {
  const notify = await resolveNotifier()
  if (!notify) return

  const tabStore = useTabStore()
  const settings = useSettingsStore()

  const unlisten = ptyRouter.onGlobalExit((id, code) => {
    if (!settings.terminalExitNotification) return

    const tab = tabStore.tabs.find((t): t is TerminalTab => t.kind === 'terminal' && t.ptyId === id)
    if (!tab) return
    if (tab.id === tabStore.activeTabId && document.hasFocus()) return

    const tabId = tab.id
    notify('Pike', `"${tab.title}" exited with code ${code}`, () => {
      // Bring Pike window to foreground and switch to the tab
      const win = getCurrentWindow()
      win.unminimize().catch(() => {})
      win.setFocus().catch(() => {})
      tabStore.setActiveTab(tabId)
    })
  })

  window.addEventListener('beforeunload', () => unlisten())
}
