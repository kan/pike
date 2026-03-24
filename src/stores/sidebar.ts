import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SidebarPanel } from '../types/tab'

const PANEL_WIDTH_KEY = 'hearth:panelWidth'
const DEFAULT_PANEL_WIDTH = 250

export const useSidebarStore = defineStore('sidebar', () => {
  const activePanel = ref<SidebarPanel | null>(null)
  const panelWidth = ref(
    parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10) || DEFAULT_PANEL_WIDTH
  )

  const isPanelOpen = computed(() => activePanel.value !== null)

  function togglePanel(panel: SidebarPanel) {
    activePanel.value = activePanel.value === panel ? null : panel
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function setPanelWidth(width: number) {
    panelWidth.value = Math.max(150, Math.min(600, width))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value))
    }, 300)
  }

  return { activePanel, panelWidth, isPanelOpen, togglePanel, setPanelWidth }
})
