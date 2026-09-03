import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useFocusPolling } from '../composables/useFocusPolling'
import { normalizeSep, pathSep } from '../lib/paths'
import { gitWorktreeList } from '../lib/tauri'
import type { GitWorktree } from '../types/git'
import { useDiagnosticsStore } from './diagnostics'
import { useDockerStore } from './docker'
import { useFileTreeStore } from './fileTree'
import { useGitStore } from './git'
import { useProjectStore } from './project'
import { useSearchStore } from './search'
import { useTaskStore } from './tasks'

export const useWorktreeStore = defineStore('worktree', () => {
  const worktrees = ref<GitWorktree[]>([])
  const loading = ref(false)

  // True once a repo with more than one worktree is detected — drives whether
  // the status-bar selector is worth showing at all.
  const hasMultiple = computed(() => worktrees.value.length > 1)

  /**
   * Whether `w` is the worktree the panels currently reference. Compares by the
   * backend `isMain` flag (not a path string) so that drive-letter/case quirks
   * in git's reported path can't desync the "main" highlight from `project.root`.
   */
  function isActive(w: GitWorktree): boolean {
    const projectStore = useProjectStore()
    const override = projectStore.activeWorktreeRoot
    if (override === null) return w.isMain
    return normalizeSep(w.path, pathSep(projectStore.currentProject?.shell)) === override
  }

  async function loadWorktrees() {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) {
      worktrees.value = []
      return
    }
    loading.value = true
    const projectId = project.id
    try {
      const sep = pathSep(project.shell)
      const list = await gitWorktreeList(project.root, project.shell)
      // Drop a result that arrived after the project changed/closed.
      if (projectStore.currentProject?.id !== projectId) return
      worktrees.value = list.map((w) => ({ ...w, path: normalizeSep(w.path, sep) }))
    } catch {
      if (projectStore.currentProject?.id === projectId) worktrees.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * Re-point the file tree / git / search / tasks / docker (and the editor's
   * git surfaces) at `w`. `activeRoot` を見ている側（App.vue のファイル監視・root に
   * 依存する usage）は自分で追従するので、ここには出てこない。
   */
  async function setActiveWorktree(w: GitWorktree) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) return

    // Store null for the main worktree so the selector collapses to "main" and
    // session state stays clean; store the normalized path otherwise.
    projectStore.activeWorktreeRoot = w.isMain ? null : normalizeSep(w.path, pathSep(project.shell))

    const fileTree = useFileTreeStore()
    const git = useGitStore()
    const search = useSearchStore()
    const tasks = useTaskStore()
    const docker = useDockerStore()

    fileTree.initTree()
    search.clear()
    useDiagnosticsStore().clear()
    await Promise.all([
      git.refreshStatus(),
      git.refreshLog(),
      git.loadBranches(),
      git.loadRemoteUrl(),
      tasks.refresh(),
      docker.refreshComposeProjects(),
    ])
  }

  function reset() {
    worktrees.value = []
  }

  // Worktrees are usually added/removed from a terminal in the same window, so
  // poll while focused to keep the selector in sync without a project reswitch.
  // Skip the spawn for non-git projects (git status stays null there).
  function poll() {
    if (useGitStore().status) loadWorktrees()
  }

  const polling = useFocusPolling([{ every: 15_000, tick: poll }])

  function startPolling() {
    loadWorktrees()
    polling.start()
  }

  return {
    worktrees,
    loading,
    hasMultiple,
    isActive,
    loadWorktrees,
    setActiveWorktree,
    reset,
    startPolling,
    stopPolling: polling.stop,
  }
})
