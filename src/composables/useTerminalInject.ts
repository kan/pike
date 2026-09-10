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
import { issueStartPrompt } from '../lib/issuePrompt'
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
  // 見えているタブから探す（#264）。全体から拾うと、パーク中の別プロジェクトの
  // ターミナルに貼り付けたうえ、そのタブをアクティブにしてしまう。
  const byId = tabStore.visibleTabs.find((t) => t.id === tabStore.lastTerminalId)
  if (isLive(byId)) return byId
  if (isLive(tabStore.activeTab)) return tabStore.activeTab
  const terminals = tabStore.visibleTabs.filter(isLive)
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

/**
 * 「この issue に着手して」をエージェントへ送る（#336）。issue パネルの 🤖 と右クリック
 * メニュー、issue タブのボタンが共有する。**文面は `lib/issuePrompt.ts` の
 * `issueStartPrompt` が正本**（同じ文面をクリップボードへ出す経路があるので、注入の側に
 * 置くと片方だけ古くなる）。
 */
export function injectIssueStart(number: number, title: string): boolean {
  return injectToTerminal(issueStartPrompt(number, title))
}
