import { BookOpen, Gauge, ScrollText, Settings, Terminal } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { Tab } from '../types/tab'

/**
 * タブ種別 → lucide のアイコン。タブバーと、溢れたときの一覧メニュー（#281）が共有する。
 *
 * **`null` は「ファイルのアイコンで出す」の意味**。ファイルを持つ種別は拡張子ごとの
 * アイコン（`lib/fileIcons.ts` の `fileIconSvg`）が先に当たるので、lucide 側は要らない。
 *
 * **`Record` にしてあるのは種別を足したときに型エラーで気付くため。** 以前は `v-else-if` を
 * 7 つ並べる形で 2 か所に写してあり、網羅性が検査されないので片方にだけ足す事故が起きえた
 * （`lib/shellIcons.ts` の `SHELL_KIND_ICONS` と同じ形）。
 */
export const TAB_KIND_ICONS: Record<Tab['kind'], Component | null> = {
  terminal: Terminal,
  'docker-logs': ScrollText,
  settings: Settings,
  'agent-status': Gauge,
  manual: BookOpen,
  editor: null,
  preview: null,
  diff: null,
  history: null,
  pdf: null,
}
