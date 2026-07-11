import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { pathSep } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import type { FsEntry } from '../lib/tauri'
import { fsListDir } from '../lib/tauri'
import { useGitStore } from './git'
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
      saveJson(storageKey(pid), [...expanded.value])
    }, 500)
  }

  function loadSavedExpanded(projectId: string): string[] {
    const parsed = loadJson<unknown>(storageKey(projectId), [])
    return Array.isArray(parsed) ? (parsed as string[]) : []
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
      // git リポジトリのときのみ gitignore を参照する（非 git での無駄な git 実行を避ける）。
      const isGitRepo = useGitStore().status !== null
      tree.value[path] = await fsListDir(project.shell, path, isGitRepo)
    } catch {
      tree.value[path] = []
    } finally {
      loading.value.delete(path)
    }
  }

  // git status は非同期取得なので、ツリーの初回ロード（復元で展開済みの dir を含む）が
  // status 到着より先だと checkGitignore=false で gitignore フラグが付かない。status が
  // 利用可能になった時点（null→非null）で既読の全ディレクトリを再取得して反映する。
  watch(
    () => useGitStore().status !== null,
    (isRepo) => {
      if (!isRepo) return
      for (const path of Object.keys(tree.value)) void loadDir(path)
    },
  )

  function initTree() {
    const projectStore = useProjectStore()
    tree.value = {}
    expanded.value.clear()
    scrollTop.value = 0
    selectedPath.value = null
    const project = projectStore.currentProject
    const root = projectStore.activeRoot
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
    const root = projectStore.activeRoot
    if (root && !tree.value[root]) {
      initTree()
    }
  }

  function invalidateDir(path: string) {
    if (path in tree.value && !expanded.value.has(path)) {
      delete tree.value[path]
    }
  }

  function invalidateCollapsed() {
    for (const path of Object.keys(tree.value)) {
      if (!expanded.value.has(path)) {
        delete tree.value[path]
      }
    }
  }

  async function revealFile(filePath: string): Promise<boolean> {
    const root = useProjectStore().activeRoot
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
    invalidateDir,
    invalidateCollapsed,
    saveExpanded,
  }
})
