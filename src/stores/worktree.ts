import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { basename, normalizeSep, pathSep } from '../lib/paths'
import { gitWorktreeList } from '../lib/tauri'
import type { GitWorktree } from '../types/git'
import { quoteArg } from '../types/tab'
import { useDiagnosticsStore } from './diagnostics'
import { useDockerStore } from './docker'
import { useFileTreeStore } from './fileTree'
import { useGitStore } from './git'
import { useProjectStore } from './project'
import { useSearchStore } from './search'
import { useTabStore } from './tabs'
import { useTaskStore } from './tasks'

export const useWorktreeStore = defineStore('worktree', () => {
  const worktrees = ref<GitWorktree[]>([])
  const loading = ref(false)
  /** 修復のコマンドを流している worktree のパス（#454）。 */
  const repairing = new Set<string>()

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
    if (w.needsRepair) {
      await repairWorktree(w)
      return
    }

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

  /**
   * 別の環境で作られた worktree の、場所の記録を直す（#454）。**確認してからターミナルで流す**:
   * リポジトリの設定（`extensions.relativeWorktrees`）が変わり、2.48 より古い git からは
   * worktree を読めなくなるので、黙っては実行しない。終わったら一覧を読み直す。
   */
  async function repairWorktree(w: GitWorktree) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    // 走っているあいだは重ねない。一覧が読み直されるまで行は「要修復」のまま残る。
    if (!project || repairing.has(w.path)) return
    // **相対パスにする**（git 2.48 以降）。絶対パスのまま直すと、今度は相手の環境から辿れなくなる。
    const command = `git worktree repair --relative-paths ${quoteArg(project.shell, w.path)}`
    if (!(await confirmDialog(t('worktree.repairConfirm', { name: basename(w.path), command })))) return
    // 確認を待つあいだにプロジェクトが替わっていたら流さない（別のプロジェクトのタブ列に開く）。
    if (projectStore.currentProject?.id !== project.id) return
    repairing.add(w.path)
    useTabStore().runCommandTab(command, project.root, project.shell, {
      keepOnError: true,
      onExit: () => {
        repairing.delete(w.path)
        void loadWorktrees()
      },
    })
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
