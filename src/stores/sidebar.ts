import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SidebarPanel } from '../types/tab'

const PANEL_WIDTH_KEY = 'pike:panelWidth'
const ACTIVE_PANEL_KEY = 'pike:activePanel'
const DEFAULT_PANEL_WIDTH = 250

const VALID_PANELS: SidebarPanel[] = ['files', 'git', 'search', 'docker', 'projects', 'tasks', 'outline']

export const useSidebarStore = defineStore('sidebar', () => {
  const saved = localStorage.getItem(ACTIVE_PANEL_KEY)
  const initial = saved && VALID_PANELS.includes(saved as SidebarPanel) ? (saved as SidebarPanel) : null
  const activePanel = ref<SidebarPanel | null>(initial)
  const panelWidth = ref(parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10) || DEFAULT_PANEL_WIDTH)

  const isPanelOpen = computed(() => activePanel.value !== null)

  function togglePanel(panel: SidebarPanel) {
    activePanel.value = activePanel.value === panel ? null : panel
    if (activePanel.value) {
      localStorage.setItem(ACTIVE_PANEL_KEY, activePanel.value)
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

  return { activePanel, panelWidth, isPanelOpen, togglePanel, setPanelWidth }
})
