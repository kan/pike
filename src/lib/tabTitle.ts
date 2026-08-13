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
import type { Tab } from '../types/tab'

/** Singleton tab kinds → the i18n key naming them. Add new singletons here. */
const SINGLETON_TITLE_KEYS: Partial<Record<Tab['kind'], string>> = {
  'agent-status': 'agentStatus.title',
  settings: 'settings.title',
  manual: 'manual.title',
}

/**
 * The name to show for a tab. Call this instead of reading `tab.title`
 * wherever a tab name reaches the screen (the tab bar, QuickOpen), so that
 * switching the UI language relabels the singleton tabs that are already open.
 */
export function tabDisplayTitle(tab: Tab): string {
  const key = SINGLETON_TITLE_KEYS[tab.kind]
  return key ? t(key) : tab.title
}
