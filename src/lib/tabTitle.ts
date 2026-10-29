/**
 * Display names for tabs.
 *
 * Most tabs carry their own name in `Tab.title` (a file name, a shell, a
 * container). The singleton views have no name of their own, and the literal
 * put there at creation time froze whatever language was active then — so
 * theirs comes from the UI language at render time instead. That makes this a
 * render-layer lookup, which is why it lives here and not in `types/tab.ts`
 * (that module stays free of value imports).
 */
import { t } from '../i18n'
import type { SINGLETON_KINDS, Tab } from '../types/tab'

/** 種別の一覧は `types/tab.ts` の `SINGLETON_KINDS` が正本。ここは名前の対応だけ持つ。 */
const SINGLETON_TITLE_KEYS: Record<(typeof SINGLETON_KINDS)[number], string> = {
  'agent-status': 'agentStatus.title',
  'sync-conflicts': 'sync.conflictsTitle',
  'sync-import': 'sync.importTitle',
  settings: 'settings.title',
  manual: 'manual.title',
}

/**
 * 固有の名前を持たない種別の名前。シングルトンは全部ここに入り（`Record` なので漏れると
 * 型エラー）、プロジェクトごとに 1 枚の種別（作業中の変更のタブ #526）も同じ事情で入る。
 * 名前の引き方を「シングルトンか」に結び付けないため、表を分けてある。
 */
const FIXED_TITLE_KEYS: Partial<Record<Tab['kind'], string>> = {
  ...SINGLETON_TITLE_KEYS,
  changes: 'changesTab.title',
}

/**
 * The name to show for a tab. Call this instead of reading `tab.title`
 * wherever a tab name reaches the screen (the tab bar, QuickOpen), so that
 * switching the UI language relabels the singleton tabs that are already open.
 */
export function tabDisplayTitle(tab: Tab): string {
  const key = FIXED_TITLE_KEYS[tab.kind]
  return key ? t(key) : tab.title
}
