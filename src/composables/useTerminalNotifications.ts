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

const RE_ANSI = new RegExp(
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' + // OSC
    '|\\x1b\\[[0-9;]*[A-Za-z]' + // CSI
    '|\\x1b[()][0-9A-Za-z]' + // charset
    '|\\x1b[=>]' + // keypad
    '|[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]', // control chars
  'g',
)

function stripAnsi(s: string): string {
  return s.replace(RE_ANSI, '')
}

const DEBOUNCE_MS = 1500
const MAX_BODY = 200
const MAX_BUF = 4096

export async function initTerminalNotifications() {
  const resolved = await resolveNotifier()
  if (!resolved) return
  const notify: NotifyFn = resolved

  const tabStore = useTabStore()
  const settings = useSettingsStore()

  function focusTab(tabId: string) {
    const win = getCurrentWindow()
    win.unminimize().catch(() => {})
    win.setFocus().catch(() => {})
    tabStore.setActiveTab(tabId)
  }

  // --- Exit notification ---
  const unlistenExit = ptyRouter.onGlobalExit((id, code) => {
    if (!settings.terminalExitNotification) return

    const tab = tabStore.tabs.find((t): t is TerminalTab => t.kind === 'terminal' && t.ptyId === id)
    if (!tab) return
    if (tab.id === tabStore.activeTabId && document.hasFocus()) return

    const tabId = tab.id
    notify('Pike', `"${tab.title}" exited with code ${code}`, () => focusTab(tabId))
  })

  // --- Output notification (window unfocused + active terminal tab) ---
  let outputBuf = ''
  let outputTimer: ReturnType<typeof setTimeout> | null = null
  let outputPtyId: string | null = null

  function flushOutputNotification() {
    outputTimer = null
    const text = stripAnsi(outputBuf).trim()
    outputBuf = ''
    if (!text) return

    const tab = tabStore.tabs.find((t): t is TerminalTab => t.kind === 'terminal' && t.ptyId === outputPtyId)
    if (!tab) return

    const body = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text
    const tabId = tab.id
    notify(tab.title, body, () => focusTab(tabId))
  }

  const unlistenOutput = ptyRouter.onGlobalOutput((id, data) => {
    if (!settings.terminalExitNotification) return
    if (document.hasFocus()) return

    // Only notify for the active terminal tab
    const activeTab = tabStore.activeTab
    if (!activeTab || activeTab.kind !== 'terminal' || activeTab.ptyId !== id) return

    // Accumulate and debounce
    if (outputPtyId !== id) {
      outputBuf = ''
      outputPtyId = id
    }
    if (outputBuf.length < MAX_BUF) {
      outputBuf += data
    }
    if (outputTimer != null) clearTimeout(outputTimer)
    outputTimer = setTimeout(flushOutputNotification, DEBOUNCE_MS)
  })

  window.addEventListener('beforeunload', () => {
    unlistenExit()
    unlistenOutput()
  })
}
