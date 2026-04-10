import { getCurrentWindow } from '@tauri-apps/api/window'
import { type NotifyFn, resolveNotifier } from '../lib/notify'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { TerminalTab } from '../types/tab'
import { ptyRouter } from './usePtyRouter'

const RE_ANSI = new RegExp(
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' + // OSC: \e]...\a or \e]...\e\\
    '|\\x1b\\[[0-9;?:]*[ -/]*[@-~]' + // CSI: \e[?25h, \e[0m, \e[2J etc.
    '|\\x1bP[^\\x1b]*\\x1b\\\\' + // DCS: \eP...\e\\
    '|\\x1b[_^][^\\x1b]*\\x1b\\\\' + // APC/PM: \e_...\e\\ , \e^...\e\\
    '|\\x1b[()#%][0-9A-Za-z]' + // charset/line attrs: \e(B, \e#8
    '|\\x1b[=>NOcDEHMZ78]' + // single-char ESC sequences
    '|[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', // C0 control (except HT/LF/CR) + DEL
  'g',
)

/** Strip escape sequences, handle \r overwrites, and clean up whitespace. */
function cleanTerminalOutput(s: string): string {
  const stripped = s.replace(RE_ANSI, '')
  // Handle \r: for each line, keep only text after last \r (progress bar overwrite)
  const lines = stripped.split('\n').map((line) => {
    const lastCR = line.lastIndexOf('\r')
    return (lastCR >= 0 ? line.slice(lastCR + 1) : line).trim()
  })
  return lines.filter(Boolean).join('\n')
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
    // Notify if tab is not active, OR if window is not focused (including virtual desktop switch)
    if (tab.id === tabStore.activeTabId && document.visibilityState === 'visible' && document.hasFocus()) return

    const tabId = tab.id
    notify('Pike', `"${tab.title}" exited with code ${code}`, () => focusTab(tabId))
  })

  // --- Output notification (window unfocused + active terminal tab) ---
  let outputBuf = ''
  let outputTimer: ReturnType<typeof setTimeout> | null = null
  let outputPtyId: string | null = null

  function flushOutputNotification() {
    outputTimer = null
    const text = cleanTerminalOutput(outputBuf)
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
