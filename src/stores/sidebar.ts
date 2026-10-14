import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { isSidebarPanel, type SidebarPanel } from '../types/tab'
import { useSettingsStore } from './settings'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'

const PANEL_WIDTH_KEY = 'pike:panelWidth'
const ACTIVE_PANEL_KEY = 'pike:activePanel'
const DEFAULT_PANEL_WIDTH = 250

export const useSidebarStore = defineStore('sidebar', () => {
  const saved = localStorage.getItem(ACTIVE_PANEL_KEY)
  // 消したパネルの名前が残っていることがあるので、開く前に一覧と突き合わせる。
  const initial = saved && isSidebarPanel(saved) ? saved : null
  const activePanel = ref<SidebarPanel | null>(initial)
  const panelWidth = ref(parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10) || DEFAULT_PANEL_WIDTH)

  const isPanelOpen = computed(() => activePanel.value !== null)

  /**
   * 今は開けないパネルか（#477）。**ブラウザのタブが見えているあいだの Git パネル**だけ。
   *
   * **判定をここに置くのは、入口が 3 つあるため**（アイコン列・パレット・キー）。どれも
   * `togglePanel` / `openPanel` を通るので、ここで断れば全部に効く。アイコン列は同じ述語で
   * 灰色にする。
   *
   * 「使えるか」（`usePanelAvailability`）には混ぜない。あちらが偽だとアイコンが列から消え、
   * タブを切り替えるたびに下のアイコンが上下に動く。
   */
  function panelBlocked(panel: SidebarPanel): boolean {
    return panel === 'git' && useTabStore().browserTabVisible
  }

  function togglePanel(panel: SidebarPanel) {
    setPanel(activePanel.value === panel ? null : panel)
  }

  /** 開くだけ（既に開いていても閉じない）。キーで開く検索（#307）と E2E が使う。 */
  function openPanel(panel: SidebarPanel) {
    setPanel(panel)
  }

  /**
   * 使えないパネルから逃がす（#353）。**覚えている選択（`pike:activePanel`）は書き換えない。**
   *
   * 人が選んだわけではないので、ここで書くと**非対応のプロジェクトを開くたびに、覚えている
   * 選択が上書きされる**（起動時にも起きるので、issue パネルを常用する人からは「選択を
   * 覚える機能」が失われる）。表示だけ移して、覚えているほうは人が選んだときだけ動かす。
   */
  function fallbackPanel(panel: SidebarPanel | null) {
    activePanel.value = panel
  }

  /**
   * ブラウザのタブが見えたら、開いている Git パネルから逃がし、見えなくなったら戻す（#477）。
   * Git パネルが開いているあいだは子 webview を隠すしかなく（`useChildWebview` の `shown`）、
   * 開けっぱなしだとページがずっと見えない。
   *
   * **ストアに置く**（`SideBar.vue` ではなく）。サイドバーを描かないグローバルモードの
   * ウィンドウでも、覚えている選択（マシンに 1 つ）が Git なら同じことが起き、そこには
   * パネルを閉じる手段が無い。
   *
   * - **逃がすのは表示だけ**（`fallbackPanel`。覚えている選択は Git のまま）。行き先は
   *   ブラウザのパネル、そのアイコンを隠していれば（#364）パネルを閉じた表示にする
   *   （アイコンの無いパネルが開いたままだと、閉じる入口が無い）
   * - **人が選び直したら戻さない**（`setPanel` が `displacedGit` を下ろす）。逃がした先と
   *   同じパネルを人が選び直した場合も、それはもう人の選択
   */
  let displacedGit = false
  watch(
    () => useTabStore().browserTabVisible,
    (visible) => {
      if (visible && activePanel.value === 'git') {
        const browserHidden = useSettingsStore().sidebarIcons.some((s) => s.panel === 'browser' && s.hidden)
        fallbackPanel(browserHidden ? null : 'browser')
        displacedGit = true
      } else if (!visible && displacedGit) {
        fallbackPanel('git')
        displacedGit = false
      }
    },
    { immediate: true },
  )

  function setPanel(panel: SidebarPanel | null) {
    // 開けないパネルは理由を出して断る（パレットやキーからは、灰色のアイコンが見えない）。
    if (panel && panelBlocked(panel)) {
      useStatusMessageStore().show({ text: t('sidebar.gitBlockedByBrowser'), variant: 'warn' })
      return
    }
    displacedGit = false
    activePanel.value = panel
    if (panel) {
      localStorage.setItem(ACTIVE_PANEL_KEY, panel)
    } else {
      localStorage.removeItem(ACTIVE_PANEL_KEY)
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function setPanelWidth(width: number) {
    panelWidth.value = Math.max(150, Math.min(600, width))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value))
    }, 300)
  }

  return {
    activePanel,
    panelWidth,
    isPanelOpen,
    panelBlocked,
    togglePanel,
    openPanel,
    setPanel,
    fallbackPanel,
    setPanelWidth,
  }
})
