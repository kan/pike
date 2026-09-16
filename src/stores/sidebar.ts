import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isSidebarPanel, type SidebarPanel } from '../types/tab'

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
  function fallbackPanel(panel: SidebarPanel) {
    activePanel.value = panel
  }

  function setPanel(panel: SidebarPanel | null) {
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

  return { activePanel, panelWidth, isPanelOpen, togglePanel, openPanel, setPanel, fallbackPanel, setPanelWidth }
})
