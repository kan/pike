import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SidebarPanel } from '../types/tab'

export const useSidebarStore = defineStore('sidebar', () => {
  const activePanel = ref<SidebarPanel | null>(null)

  const isPanelOpen = computed(() => activePanel.value !== null)

  function togglePanel(panel: SidebarPanel) {
    activePanel.value = activePanel.value === panel ? null : panel
  }

  return { activePanel, isPanelOpen, togglePanel }
})
