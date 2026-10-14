import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { confirmDialog, confirmWithOption } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { parseJsonc } from '../lib/jsonc'
import { basename, joinPath, normalizeSep, pathSep } from '../lib/paths'
import { rootKey } from '../lib/projectPaths'
import { fsReadFile, gitStatus, gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove } from '../lib/tauri'
import { includeFromVscodeSettings, includeFromWorktreeInclude, resolveWorktreePath } from '../lib/worktreeCreate'
import type { GitWorktree, GitWorktreeAdded } from '../types/git'
import { quoteArg, type ShellType } from '../types/tab'
import { useDiagnosticsStore } from './diagnostics'
import { useDockerStore } from './docker'
import { useFileTreeStore } from './fileTree'
import { useGitStore } from './git'
import { useProjectStore } from './project'
import { useSearchStore } from './search'
import { useSettingsStore } from './settings'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'
import { useTaskStore } from './tasks'

/**
 * 持っていく gitignore 済みのファイルのパターン（#478）。VS Code の設定
 * （`.vscode/settings.json` の `git.worktreeIncludeFiles`）と `.worktreeinclude` の両方を読み、
 * 前者を先に並べる。読めないファイルは無いものとして扱う。
 */
async function readIncludePatterns(root: string, shell: ShellType): Promise<string[]> {
  const sep = pathSep(shell)
  const read = async (rel: string): Promise<string | null> => {
    try {
      const file = await fsReadFile(shell, joinPath(root, rel, sep), undefined, { allowMissing: true })
      return file.isNew ? null : file.content
    } catch {
      return null
    }
  }
  const [vscode, include] = await Promise.all([read('.vscode/settings.json'), read('.worktreeinclude')])
  return [
    ...(vscode === null ? [] : includeFromVscodeSettings(parseJsonc(vscode))),
    ...(include === null ? [] : includeFromWorktreeInclude(include)),
  ]
}

export const useWorktreeStore = defineStore('worktree', () => {
  const worktrees = ref<GitWorktree[]>([])
  const loading = ref(false)
  /** 修復のコマンドを流している worktree のパス（#454）。 */
  const repairing = new Set<string>()
  /**
   * `worktrees` がどのプロジェクトの一覧か（#478）。**プロジェクトを切り替えても一覧は
   * 読み直しが返るまで前のまま**（`reset` はプロジェクトが無くなったときだけ）なので、
   * 作成の基準（main の worktree）を一覧から引く側はこれを確かめる。
   */
  let listedFor: string | null = null

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
      listedFor = projectId
    } catch {
      if (projectStore.currentProject?.id === projectId) {
        worktrees.value = []
        listedFor = projectId
      }
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

  /** main の worktree のルート。一覧がこのプロジェクトのものでなければプロジェクトのルート。 */
  function mainRoot(project: { id: string; root: string }): string {
    const listed = listedFor === project.id ? worktrees.value : []
    return listed.find((w) => w.isMain)?.path ?? project.root
  }

  /**
   * 名前 `name` で作るときの worktree のパス（`~` は未展開）と、基準にする main の worktree の
   * ルート（一覧がまだ無ければプロジェクトのルート）。ダイアログの表示と `createWorktree` が
   * 同じものを使う。プロジェクトが無ければ `null`。
   */
  function plannedPath(name: string): { main: string; path: string } | null {
    const project = useProjectStore().currentProject
    if (!project) return null
    const main = mainRoot(project)
    const location = useSettingsStore().worktreeLocationFor(project.shell)
    return { main, path: resolveWorktreePath(location, main, name, project.shell) }
  }

  /** 作成のダイアログ（`components/CreateWorktreeDialog.vue`）を開いているか。 */
  const createDialogOpen = ref(false)

  /**
   * 作成のダイアログを開く（#478）。入口はステータスバーのメニューとパレット。git の
   * リポジトリでなければ開かずに知らせる（パレットからはどのプロジェクトでも呼べる）。
   */
  function openCreateDialog() {
    if (!useGitStore().status) {
      useStatusMessageStore().show({ text: t('worktree.createNotRepo'), variant: 'warn' })
      return
    }
    createDialogOpen.value = true
  }

  /**
   * worktree を新しいブランチ `name` で作り、そこへ切り替える（#478）。置き場所は設定
   * （`worktreeLocationFor`）から、持っていくファイルは main の worktree の設定ファイルから
   * 決める。**基準は main の worktree**: 別の worktree を選んでいるあいだに作っても、相対の
   * 置き場所とコピーの元は main のまま（`.env` を置いているのは普通そちら）。
   *
   * 失敗は reject する（ダイアログがそのまま文言を出す）。作ったあとプロジェクトが
   * 切り替わっていたら、切り替えはしない。**切り替えたかを `switched` で返す**: ターミナルを
   * 開くのはダイアログで、切り替えなかったときに開くと別のプロジェクトのタブ列に出る。
   */
  async function createWorktree(name: string, base: string): Promise<{ added: GitWorktreeAdded; switched: boolean }> {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    const planned = plannedPath(name)
    if (!project || !planned) throw new Error(t('worktree.createNotRepo'))
    const include = await readIncludePatterns(planned.main, project.shell)
    const added = await gitWorktreeAdd(planned.main, project.shell, planned.path, name, base, include)
    if (projectStore.currentProject?.id !== project.id) return { added, switched: false }
    await loadWorktrees()
    const created = worktrees.value.find((w) => rootKey(w.path) === rootKey(added.path))
    if (created) await setActiveWorktree(created)
    return { added, switched: !!created }
  }

  /** 削除を流している worktree のパス。走っているあいだは同じ行を重ねて消さない。 */
  const removing = new Set<string>()

  /**
   * worktree を消す（#478）。入口は worktree セレクタの行のゴミ箱。**main・参照中・要修復は
   * 消さない**（参照中を消させないのは利用者の判断。先に別の worktree へ切り替えてもらう）。
   *
   * 必ず確認を挟み、その文面で失うものを知らせる: 未コミットの変更と未追跡のファイルの数
   * （`git status` で数える。gitignore 済みのものは数えない＝git も確認なしで消す）と、lock の
   * 理由。ブランチも消すかは確認ダイアログのチェックボックスで選ばせる（既定は残す）。
   */
  async function removeWorktree(w: GitWorktree) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project || w.isMain || w.needsRepair || isActive(w) || removing.has(w.path)) return
    const status = useStatusMessageStore()
    const name = basename(w.path)
    // ステージと作業ツリーの両方に出るファイル（`MM`）を二重に数えないよう、パスで数える。
    // 数えられなかったら `null`。lock されていると `--force` を付けるので、そのときは「確かめ
    // られなかった」と文面に書く（git に断らせる側へは倒れない）。
    const changes = await gitStatus(w.path, project.shell)
      .then((s) => new Set([...s.staged, ...s.unstaged, ...s.conflicted].map((c) => c.path)).size)
      .catch(() => null)
    const lines = [t('worktree.removeConfirm', { name, path: w.path })]
    if (changes === null) lines.push(t('worktree.removeDirtyUnknown'))
    else if (changes > 0) lines.push(t('worktree.removeDirty', { count: changes }))
    if (w.locked !== null) lines.push(t('worktree.removeLocked', { reason: w.locked || '-' }))
    const branchLabel = w.branch ? t('worktree.removeBranch', { branch: w.branch }) : ''
    const { ok, checked } = await confirmWithOption(lines.join('\n\n'), branchLabel)
    // 確認を待つあいだにプロジェクトが替わっていたら流さない（別のリポジトリへ向かう）。
    if (!ok || projectStore.currentProject?.id !== project.id || isActive(w)) return
    removing.add(w.path)
    status.show({ text: t('worktree.removing', { name }), variant: 'loading' })
    try {
      const branch = checked && w.branch ? w.branch : null
      const result = await gitWorktreeRemove(
        mainRoot(project),
        project.shell,
        w.path,
        // 数えられなかったときは付けない（変更があれば git が断る。lock なら上で知らせてある）。
        (changes ?? 0) > 0,
        w.locked !== null,
        branch,
      )
      if (branch && result.branchKept) {
        status.show({
          text: t('worktree.branchKept', { name, branch, reason: result.branchKept }),
          variant: 'warn',
          durationMs: 8000,
        })
      } else {
        status.show({ text: t('worktree.removed', { name }), variant: 'success' })
      }
    } catch (e) {
      status.show({
        text: t('worktree.removeFailed', { name, error: e instanceof Error ? e.message : String(e) }),
        variant: 'error',
        durationMs: 8000,
      })
    } finally {
      removing.delete(w.path)
      void loadWorktrees()
    }
  }

  function reset() {
    worktrees.value = []
    listedFor = null
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
    createDialogOpen,
    openCreateDialog,
    plannedPath,
    createWorktree,
    removeWorktree,
    reset,
    startPolling,
    stopPolling: polling.stop,
  }
})
