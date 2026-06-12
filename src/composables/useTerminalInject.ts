/**
 * Send text/context from elsewhere in Pike (editor selection, diagnostics) into
 * a running terminal — the bridge that lets the editor/problems panels feed a
 * coding agent that the user runs as `claude` in a terminal tab.
 *
 * Resolution order for the target terminal: the last-active terminal, then the
 * active tab if it is one, then a pinned terminal, then any terminal. Injection
 * uses bracketed paste (no trailing CR) so multi-line content arrives as one
 * input without submitting — the user reviews and presses Enter.
 */

import { t } from '../i18n'
import { ptyPasteText } from '../lib/tauri'
import { useStatusMessageStore } from '../stores/statusMessage'
import { useTabStore } from '../stores/tabs'
import type { Tab, TerminalTab } from '../types/tab'

type LiveTerminal = TerminalTab & { ptyId: string }

function isLive(tab: Tab | null | undefined): tab is LiveTerminal {
  return !!tab && tab.kind === 'terminal' && !!tab.ptyId
}

function resolveTarget(): LiveTerminal | null {
  const tabStore = useTabStore()
  const byId = tabStore.tabs.find((t) => t.id === tabStore.lastTerminalId)
  if (isLive(byId)) return byId
  if (isLive(tabStore.activeTab)) return tabStore.activeTab
  const terminals = tabStore.tabs.filter(isLive)
  return terminals.find((t) => t.pinned) ?? terminals[0] ?? null
}

/**
 * Inject `text` into the resolved target terminal and activate it. Returns false
 * (and surfaces a status message) when no terminal is available.
 */
export function injectToTerminal(text: string): boolean {
  const target = resolveTarget()
  if (!target) {
    useStatusMessageStore().show({ text: t('terminal.injectNoTarget'), variant: 'warn' })
    return false
  }
  ptyPasteText(target.ptyId, text).catch(() => {})
  useTabStore().setActiveTab(target.id)
  return true
}
