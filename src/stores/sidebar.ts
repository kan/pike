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

  return { activePanel, panelWidth, isPanelOpen, togglePanel, openPanel, setPanel, setPanelWidth }
})
