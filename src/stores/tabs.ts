import { getCurrentWindow } from '@tauri-apps/api/window'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { ptyRouter } from '../composables/usePtyRouter'
import { t } from '../i18n'
import { basename } from '../lib/paths'
import { ptyKill, waitSignalByPath } from '../lib/tauri'
import type { LastSession, SessionTabDef } from '../types/project'
import type {
  DiffTab,
  DockerLogsTab,
  EditorTab,
  HistoryTab,
  PdfTab,
  PreviewTab,
  SettingsTab,
  ShellType,
  Tab,
  TerminalTab,
} from '../types/tab'

let counter = 0

function genId(): string {
  return `tab-${Date.now()}-${++counter}`
}

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)

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

  async function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    if (tabs.value[idx].pinned) return

    // Confirm close if editor tab has unsaved changes (title ends with *)
    const tab = tabs.value[idx]
    if (tab.kind === 'editor' && tab.title.endsWith(' *')) {
      if (!(await confirmDialog(t('confirm.unsavedClose', { name: tab.title.slice(0, -2) })))) {
        return
      }
    }

    // Kill PTY session before removing tab to prevent wsl.exe process leaks
    if (tab.kind === 'terminal' && tab.ptyId) {
      ptyRouter.unregister(tab.ptyId)
      await ptyKill(tab.ptyId).catch(() => {})
    }

    tabs.value.splice(idx, 1)
    untitledContent.delete(id)

    if (tab.kind === 'editor') {
      await signalWaitAndCloseWindow(tab.path)
    }

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
    untitledContent.clear()
    tabs.value = []
    activeTabId.value = null
  }

  // Clear activity indicator whenever any tab becomes active,
  // regardless of which code path changed activeTabId (setActiveTab, cycleTab, closeTab, etc.)
  watch(activeTabId, (newId) => {
    if (newId) {
      const tab = tabs.value.find((t) => t.id === newId)
      if (tab?.kind === 'terminal') {
        tab.hasActivity = false
      }
    }
  })

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
    initialLine?: number
    reload?: boolean
  }): string {
    if (!options.initialContent) {
      const existing = tabs.value.find(
        (t): t is EditorTab => t.kind === 'editor' && t.path === options.path && !t.readOnly,
      )
      if (existing) {
        if (options.initialLine) {
          existing.initialLine = options.initialLine
        }
        if (options.reload) {
          existing.reloadRequested = Date.now()
        }
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
      initialLine: options.initialLine,
    })
    activeTabId.value = id
    return id
  }

  /** Non-reactive storage for untitled tab content to avoid $subscribe churn on every keystroke. */
  const untitledContent = new Map<string, string>()

  let untitledCounter = 0

  function addBlankEditorTab(options?: { title?: string; content?: string }): string {
    untitledCounter++
    const title =
      options?.title ?? (untitledCounter === 1 ? t('editor.untitled') : t('editor.untitledN', { n: untitledCounter }))
    const content = options?.content ?? ''
    const id = genId()
    tabs.value.push({
      id,
      kind: 'editor',
      title,
      pinned: false,
      path: '',
      initialContent: content,
    })
    activeTabId.value = id
    return id
  }

  function addPreviewTab(options: { path: string; dataUrl: string }): string {
    const existing = tabs.value.find((t): t is PreviewTab => t.kind === 'preview' && t.path === options.path)
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

  function addDockerLogsTab(options: { containerId: string; containerName: string }): string {
    const existing = tabs.value.find(
      (t): t is DockerLogsTab => t.kind === 'docker-logs' && t.containerId === options.containerId,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({
      id,
      kind: 'docker-logs',
      title: `${options.containerName} logs`,
      pinned: false,
      containerId: options.containerId,
      containerName: options.containerName,
    })
    activeTabId.value = id
    return id
  }

  function addHistoryTab(options: { filePath: string }): string {
    const existing = tabs.value.find((t): t is HistoryTab => t.kind === 'history' && t.filePath === options.filePath)
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({
      id,
      kind: 'history',
      title: `${basename(options.filePath)} (history)`,
      pinned: false,
      filePath: options.filePath,
    })
    activeTabId.value = id
    return id
  }

  function addSettingsTab(): string {
    const existing = tabs.value.find((t): t is SettingsTab => t.kind === 'settings')
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({ id, kind: 'settings', title: 'Settings', pinned: false })
    activeTabId.value = id
    return id
  }

  function addPdfTab(options: { path: string }): string {
    const existing = tabs.value.find((t): t is PdfTab => t.kind === 'pdf' && t.path === options.path)
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    tabs.value.push({ id, kind: 'pdf', title: basename(options.path), pinned: false, path: options.path })
    activeTabId.value = id
    return id
  }

  function addDiffTab(options: { filePath: string; diff: string; commitHash?: string; staged?: boolean }): string {
    // Reuse existing diff tab for the same file+context
    const existing = tabs.value.find(
      (t): t is DiffTab =>
        t.kind === 'diff' &&
        t.filePath === options.filePath &&
        t.commitHash === options.commitHash &&
        t.staged === options.staged,
    )
    if (existing) {
      existing.diff = options.diff
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    const fileName = basename(options.filePath)
    const title = options.commitHash ? `${fileName} (${options.commitHash.slice(0, 7)})` : `${fileName} (diff)`
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

  function moveTab(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= tabs.value.length) return
    if (toIndex < 0 || toIndex >= tabs.value.length) return
    const [moved] = tabs.value.splice(fromIndex, 1)
    tabs.value.splice(toIndex, 0, moved)
  }

  async function closeTabs(ids: string[]) {
    const toClose = tabs.value.filter((t) => ids.includes(t.id) && !t.pinned)
    if (toClose.length === 0) return

    const dirtyEditors = toClose.filter((t) => t.kind === 'editor' && t.title.endsWith(' *'))
    if (dirtyEditors.length > 0) {
      const names = dirtyEditors.map((t) => t.title.slice(0, -2)).join(', ')
      const msg =
        dirtyEditors.length === 1
          ? t('confirm.unsavedClose', { name: names })
          : t('confirm.unsavedCloseMulti', { count: dirtyEditors.length, names })
      if (!(await confirmDialog(msg))) return
    }

    // Kill PTY sessions before removing tabs to prevent wsl.exe process leaks
    const ptyKills = toClose
      .filter((t): t is TerminalTab & { ptyId: string } => t.kind === 'terminal' && !!t.ptyId)
      .map((t) => {
        ptyRouter.unregister(t.ptyId)
        return ptyKill(t.ptyId).catch(() => {})
      })
    await Promise.allSettled(ptyKills)

    // Signal all --wait processes, then close window if any were signaled
    let shouldClose = false
    for (const tab of toClose) {
      if (tab.kind === 'editor') {
        const signaled = await waitSignalByPath(tab.path).catch(() => false)
        if (signaled) shouldClose = true
      }
    }

    const idsToClose = new Set(toClose.map((t) => t.id))
    tabs.value = tabs.value.filter((t) => !idsToClose.has(t.id))

    if (!tabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = tabs.value[tabs.value.length - 1]?.id ?? null
    }

    if (shouldClose) {
      await getCurrentWindow()
        .close()
        .catch(() => {})
    }
  }

  /** Signal --wait processes for a file path; close window if any were waiting. */
  async function signalWaitAndCloseWindow(path: string) {
    const signaled = await waitSignalByPath(path).catch(() => false)
    if (signaled) {
      await getCurrentWindow()
        .close()
        .catch(() => {})
    }
  }

  async function closeOtherTabs(keepId: string) {
    await closeTabs(tabs.value.filter((t) => t.id !== keepId).map((t) => t.id))
  }

  async function closeTabsToRight(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    await closeTabs(tabs.value.slice(idx + 1).map((t) => t.id))
  }

  async function closeSavedTabs() {
    const ids = tabs.value.filter((t) => !t.pinned && !(t.kind === 'editor' && t.title.endsWith(' *'))).map((t) => t.id)
    await closeTabs(ids)
  }

  async function closeAllTabs() {
    await closeTabs(tabs.value.map((t) => t.id))
  }

  function cycleTab(direction: 'next' | 'prev') {
    if (tabs.value.length <= 1) return
    const idx = tabs.value.findIndex((t) => t.id === activeTabId.value)
    if (idx === -1) return

    const nextIdx =
      direction === 'next' ? (idx + 1) % tabs.value.length : (idx - 1 + tabs.value.length) % tabs.value.length
    activeTabId.value = tabs.value[nextIdx].id
  }

  function snapshotSession(): LastSession {
    const sessionTabs: SessionTabDef[] = tabs.value
      .filter((t) => t.kind === 'terminal' || t.kind === 'editor')
      .map((t) => {
        const base = { id: t.id, kind: t.kind as 'terminal' | 'editor', title: t.title, pinned: t.pinned }
        if (t.kind === 'terminal') {
          return { ...base, autoStart: t.autoStart }
        }
        if (t.kind === 'editor') {
          if (!t.path) {
            return { ...base, path: '', content: untitledContent.get(t.id) ?? '' }
          }
          return { ...base, path: t.path }
        }
        return base
      })
    return { tabs: sessionTabs, activeTabId: activeTabId.value }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    addTerminalTab,
    addEditorTab,
    addBlankEditorTab,
    untitledContent,
    addPreviewTab,
    addHistoryTab,
    addDockerLogsTab,
    addSettingsTab,
    addDiffTab,
    addPdfTab,
    closeTab,
    clearAllTabs,
    closeOtherTabs,
    closeTabsToRight,
    closeSavedTabs,
    closeAllTabs,
    moveTab,
    setActiveTab,
    setPtyId,
    setTabTitle,
    togglePin,
    cycleTab,
    snapshotSession,
  }
})
