import { defineStore } from 'pinia'
import { ref } from 'vue'
import { pathSep } from '../lib/paths'
import type { FsEntry } from '../lib/tauri'
import { fsListDir } from '../lib/tauri'
import { useProjectStore } from './project'

export const useFileTreeStore = defineStore('fileTree', () => {
  const tree = ref<Record<string, FsEntry[]>>({})
  const expanded = ref<Set<string>>(new Set())
  const loading = ref<Set<string>>(new Set())
  const scrollTop = ref(0)
  const selectedPath = ref<string | null>(null)

  let currentProjectId: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function storageKey(projectId: string): string {
    return `pike:fileTree:expanded:${projectId}`
  }

  function saveExpanded() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const pid = currentProjectId
      if (!pid) return
      try {
        localStorage.setItem(storageKey(pid), JSON.stringify([...expanded.value]))
      } catch {}
    }, 500)
  }

  function loadSavedExpanded(projectId: string): string[] {
    try {
      const raw = localStorage.getItem(storageKey(projectId))
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function sep(): string {
    return pathSep(useProjectStore().currentProject?.shell)
  }

  async function loadDir(path: string) {
    if (loading.value.has(path)) return
    const project = useProjectStore().currentProject
    if (!project) return
    loading.value.add(path)
    try {
      tree.value[path] = await fsListDir(project.shell, path)
    } catch {
      tree.value[path] = []
    } finally {
      loading.value.delete(path)
    }
  }

  function initTree() {
    const projectStore = useProjectStore()
    tree.value = {}
    expanded.value.clear()
    scrollTop.value = 0
    selectedPath.value = null
    const project = projectStore.currentProject
    const root = project?.root
    currentProjectId = project?.id ?? null
    if (!root) return

    const saved = currentProjectId ? loadSavedExpanded(currentProjectId) : []
    const s = pathSep(project?.shell)

    expanded.value.add(root)
    for (const path of saved) {
      if (path.startsWith(root + s) || path === root) {
        expanded.value.add(path)
      }
    }

    // Load all expanded directories concurrently
    for (const dir of expanded.value) {
      loadDir(dir)
    }
  }

  function ensureInit() {
    const projectStore = useProjectStore()
    const pid = projectStore.currentProject?.id ?? null
    if (pid !== currentProjectId) {
      initTree()
      return
    }
    const root = projectStore.currentProject?.root
    if (root && !tree.value[root]) {
      initTree()
    }
  }

  async function revealFile(filePath: string): Promise<boolean> {
    const root = useProjectStore().currentProject?.root
    if (!root) return false

    const s = sep()
    if (!filePath.startsWith(root + s) && filePath !== root) return false

    const relative = filePath.slice(root.length + s.length)
    const parts = relative.split(s)
    const dirs: string[] = [root]
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      current = current + s + parts[i]
      dirs.push(current)
    }

    for (const dir of dirs) {
      if (!expanded.value.has(dir)) {
        expanded.value.add(dir)
      }
      if (!tree.value[dir]) {
        await loadDir(dir)
      }
    }

    selectedPath.value = filePath
    saveExpanded()
    return true
  }

  return {
    tree,
    expanded,
    loading,
    scrollTop,
    selectedPath,
    loadDir,
    initTree,
    ensureInit,
    revealFile,
    saveExpanded,
  }
})
