import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ptyKill } from '../lib/tauri'
import { ptyRouter } from '../composables/usePtyRouter'
import type { Tab, TerminalTab, ShellType } from '../types/tab'

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

  function addTerminalTab(options?: {
    id?: string
    title?: string
    pinned?: boolean
    autoStart?: string
    cwd?: string
    shell?: ShellType
  }): string {
    const id = options?.id ?? genId()
    tabs.value.push({
      id,
      kind: 'terminal',
      title: options?.title ?? 'Shell',
      pinned: options?.pinned ?? false,
      ptyId: null,
      autoStart: options?.autoStart,
      cwd: options?.cwd,
      shell: options?.shell,
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
      const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
      activeTabId.value = next?.id ?? null
    }
  }

  async function clearAllTabs() {
    const kills = tabs.value
      .filter((t): t is TerminalTab & { ptyId: string } => t.kind === 'terminal' && !!t.ptyId)
      .map((t) => {
        ptyRouter.unregister(t.ptyId)
        return ptyKill(t.ptyId).catch(() => {})
      })
    await Promise.allSettled(kills)
    tabs.value = []
    activeTabId.value = null
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

  function setTabTitle(id: string, title: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) {
      tab.title = title
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
    clearAllTabs,
    setActiveTab,
    setPtyId,
    setTabTitle,
    togglePin,
    cycleTab,
  }
})
