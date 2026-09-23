import {
  BookOpen,
  FileInput,
  Gauge,
  GitCommitHorizontal,
  GitMerge,
  Globe,
  ListTodo,
  ScrollText,
  Settings,
  Terminal,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { Tab } from '../types/tab'
import { browserIcon } from './browserIcons'
import { fileIconSvg } from './fileIcons'

/**
 * 画像で出すアイコン（ブラウザのタブのサイトのアイコン、#400）の data URL。
 * まだ取れていなければ `null` で、呼び出し側は `TAB_KIND_ICONS` の地球儀へ落ちる。
 */
export function tabImageIcon(tab: Tab): string | null {
  return tab.kind === 'browser' ? browserIcon(tab.url) : null
}

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
  'sync-conflicts': GitMerge,
  'sync-import': FileInput,
  manual: BookOpen,
  // サイドバーの issue パネルと同じアイコン（#278）。
  issue: ListTodo,
  commit: GitCommitHorizontal,
  browser: Globe,
  editor: null,
  preview: null,
  diff: null,
  history: null,
  pdf: null,
}

/**
 * ファイルを持つ種別の、拡張子ごとのアイコン（`TAB_KIND_ICONS` が `null` を返す側）。
 * 持たない種別は `null` を返すので、呼び出し側は lucide のほうへ落ちる。
 *
 * `TAB_KIND_ICONS` と同じ場所に置いてあるのは、**タブ 1 つを描く側（`TabItem`）と
 * 一覧メニュー（`TabBar`）が同じ組を読む**ため。描き方は `components/layout/TabIcon.vue` の 1 つ。
 */
export function tabFileIconSvg(tab: Tab): string | null {
  switch (tab.kind) {
    case 'editor':
    case 'preview':
    case 'pdf':
      return fileIconSvg(tab.path)
    case 'diff':
    case 'history':
      return fileIconSvg(tab.filePath)
    default:
      return null
  }
}
