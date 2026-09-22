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

export type LiveTerminal = TerminalTab & { ptyId: string }

export function isLiveTerminal(tab: Tab | null | undefined): tab is LiveTerminal {
  return !!tab && tab.kind === 'terminal' && !!tab.ptyId
}

/**
 * 流し込む先のターミナル（このモジュールの doc の順）。
 *
 * **公開してあるのは、同じ「どのターミナルか」を聞く側がほかにもあるため**（#373 の
 * 「ターミナルの cwd をプロジェクトとして登録」）。各所で選び直すと、注入と登録で
 * 別のタブを相手にしうる。
 */
export function resolveTargetTerminal(): LiveTerminal | null {
  const tabStore = useTabStore()
  // 見えているタブから探す（#264）。全体から拾うと、パーク中の別プロジェクトの
  // ターミナルに貼り付けたうえ、そのタブをアクティブにしてしまう。
  const byId = tabStore.visibleTabs.find((t) => t.id === tabStore.lastTerminalId)
  if (isLiveTerminal(byId)) return byId
  if (isLiveTerminal(tabStore.activeTab)) return tabStore.activeTab
  const terminals = tabStore.visibleTabs.filter(isLiveTerminal)
  return terminals.find((t) => t.pinned) ?? terminals[0] ?? null
}

/**
 * Inject `text` into the resolved target terminal and hand it the focus. Returns
 * false (and surfaces a status message) when no terminal is available.
 *
 * **フォーカスまで渡すのは `tabStore.focusTerminal` の仕事**（#355）。流し込んだ直後に
 * 打てないと、貼り付いた文をそのまま送るのにマウスでターミナルを 1 回押すことになる。
 * `setActiveTab` では足りない理由はあちらの doc が正本。
 */
export function injectToTerminal(text: string): boolean {
  const target = resolveTargetTerminal()
  if (!target) {
    useStatusMessageStore().show({ text: t('terminal.injectNoTarget'), variant: 'warn' })
    return false
  }
  ptyPasteText(target.ptyId, text).catch(() => {})
  useTabStore().focusTerminal(target.id)
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
