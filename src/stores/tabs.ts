import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Tab } from '../types/tab'

let counter = 0

function genId(): string {
  return `tab-${Date.now()}-${++counter}`
}

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)

  const activeTab = computed(() =>
    tabs.value.find((t) => t.id === activeTabId.value) ?? null
  )

  function addTerminalTab(options?: { title?: string; pinned?: boolean }): string {
    const id = genId()
    tabs.value.push({
      id,
      kind: 'terminal',
      title: options?.title ?? 'Shell',
      pinned: options?.pinned ?? false,
      ptyId: null,
    })
    activeTabId.value = id
    return id
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    if (tabs.value[idx].pinned) return

    tabs.value.splice(idx, 1)

    if (activeTabId.value === id) {
      // Select adjacent tab: prefer right, then left, then null
      const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
      activeTabId.value = next?.id ?? null
    }
  }

  function setActiveTab(id: string) {
    if (tabs.value.some((t) => t.id === id)) {
      activeTabId.value = id
    }
  }

  function setPtyId(tabId: string, ptyId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab && tab.kind === 'terminal') {
      tab.ptyId = ptyId
    }
  }

  function togglePin(id: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) {
      tab.pinned = !tab.pinned
    }
  }

  function cycleTab(direction: 'next' | 'prev') {
    if (tabs.value.length <= 1) return
    const idx = tabs.value.findIndex((t) => t.id === activeTabId.value)
    if (idx === -1) return

    const nextIdx =
      direction === 'next'
        ? (idx + 1) % tabs.value.length
        : (idx - 1 + tabs.value.length) % tabs.value.length
    activeTabId.value = tabs.value[nextIdx].id
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    addTerminalTab,
    closeTab,
    setActiveTab,
    setPtyId,
    togglePin,
    cycleTab,
  }
})
