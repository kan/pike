import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ptyKill } from '../lib/tauri'
import { ptyRouter } from '../composables/usePtyRouter'
import type { Tab, TerminalTab, EditorTab, DiffTab, PreviewTab, HistoryTab, ShellType } from '../types/tab'
import { basename } from '../lib/paths'

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

    // Confirm close if editor tab has unsaved changes (title ends with *)
    const tab = tabs.value[idx]
    if (tab.kind === 'editor' && tab.title.endsWith(' *')) {
      if (!confirm(`"${tab.title.slice(0, -2)}" has unsaved changes. Close without saving?`)) {
        return
      }
    }

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

  function addEditorTab(options: {
    path: string
    readOnly?: boolean
    initialContent?: string
    titleSuffix?: string
  }): string {
    // For read-only tabs with initialContent, don't deduplicate (each revision is unique)
    if (!options.initialContent) {
      const existing = tabs.value.find(
        (t): t is EditorTab => t.kind === 'editor' && t.path === options.path && !t.readOnly
      )
      if (existing) {
        activeTabId.value = existing.id
        return existing.id
      }
    }
    const id = genId()
    const fileName = basename(options.path) + (options.titleSuffix ?? '')
    tabs.value.push({
      id,
      kind: 'editor',
      title: fileName,
      pinned: false,
      path: options.path,
      readOnly: options.readOnly,
      initialContent: options.initialContent,
    })
    activeTabId.value = id
    return id
  }

  function addPreviewTab(options: { path: string; dataUrl: string }): string {
    const existing = tabs.value.find(
      (t): t is PreviewTab => t.kind === 'preview' && t.path === options.path
    )
    if (existing) {
      existing.dataUrl = options.dataUrl
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({
      id,
      kind: 'preview',
      title: basename(options.path),
      pinned: false,
      path: options.path,
      dataUrl: options.dataUrl,
    })
    activeTabId.value = id
    return id
  }

  function addHistoryTab(options: { filePath: string }): string {
    const existing = tabs.value.find(
      (t): t is HistoryTab => t.kind === 'history' && t.filePath === options.filePath
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({
      id,
      kind: 'history',
      title: basename(options.filePath) + ' (history)',
      pinned: false,
      filePath: options.filePath,
    })
    activeTabId.value = id
    return id
  }

  function addDiffTab(options: {
    filePath: string
    diff: string
    commitHash?: string
    staged?: boolean
  }): string {
    // Reuse existing diff tab for the same file+context
    const existing = tabs.value.find(
      (t): t is DiffTab =>
        t.kind === 'diff' &&
        t.filePath === options.filePath &&
        t.commitHash === options.commitHash &&
        t.staged === options.staged
    )
    if (existing) {
      existing.diff = options.diff
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    const fileName = basename(options.filePath)
    const title = options.commitHash
      ? `${fileName} (${options.commitHash.slice(0, 7)})`
      : `${fileName} (diff)`
    tabs.value.push({
      id,
      kind: 'diff',
      title,
      pinned: false,
      filePath: options.filePath,
      diff: options.diff,
      commitHash: options.commitHash,
      staged: options.staged,
    })
    activeTabId.value = id
    return id
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
    addEditorTab,
    addPreviewTab,
    addHistoryTab,
    addDiffTab,
    closeTab,
    clearAllTabs,
    setActiveTab,
    setPtyId,
    setTabTitle,
    togglePin,
    cycleTab,
  }
})
