import { defineStore } from 'pinia'
import { ref } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import {
  gitBranchList,
  gitCheckout,
  gitCheckoutTrack,
  gitCommit,
  gitDiscardChanges,
  gitFetch,
  gitInit,
  gitIsRepo,
  gitLog,
  gitPull,
  gitPush,
  gitRemoteUrl,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../lib/tauri'
import { windowFocused } from '../lib/window'
import type { GitLogEntry, GitStatusResult, PullOption, PushOption } from '../types/git'
import { chainOnSuccess } from '../types/tab'
import { useProjectStore } from './project'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'

/**
 * Local branch a remote-tracking branch maps to (`origin/foo` → `foo`). Only for
 * display decisions: the actual checkout lets git derive the name, which stays
 * correct even for the rare remote whose own name contains a slash.
 */
export function localBranchName(remoteBranch: string): string {
  const slash = remoteBranch.indexOf('/')
  return slash < 0 ? remoteBranch : remoteBranch.slice(slash + 1)
}

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const branches = ref<string[]>([])
  // Remote-tracking branches (`origin/foo`), offered by the switcher alongside
  // the local ones (#197).
  const remoteBranches = ref<string[]>([])
  const fetchingBranches = ref(false)
  const remoteUrl = ref<string | null>(null)
  const error = ref<string | null>(null)
  // Whether the active root is a git repository. `false` drives the panel's
  // "initialize repository" view instead of surfacing a raw git error.
  const isRepo = ref(true)
  const pushing = ref(false)
  const pulling = ref(false)

  /**
   * 失敗を記録し、**ステータスバーにも出す**（#270）。Git パネルのストリップだけだと、
   * パネルを閉じたまま実行したとき（パレットやサイドバーのボタン）に「何も起きなかった」
   * ように見える。入口ごとに通知を書くと、どれかが漏れる。
   */
  function setError(message: string) {
    error.value = message
    useStatusMessageStore().show({ text: message, variant: 'error', durationMs: 8000 })
  }

  /** ステータスとログをまとめて取り直す（「更新」の実体。入口が 2 つある）。 */
  async function refreshAll() {
    await Promise.all([refreshStatus(true), refreshLog()])
  }

  const refreshing = ref(false)
  let statusInFlight: Promise<void> | null = null
  let statusPending: Promise<void> | null = null
  let logInFlight: Promise<void> | null = null
  let logPending: Promise<void> | null = null
  let fetchGuard = false
  let lastFetchTime = 0
  const logAllMode = ref(false)
  // Status from the previous poll. When HEAD/ahead/behind change between polls —
  // e.g. a commit made in a terminal, a pull, or a branch switch — the commit
  // log is stale and must be refreshed alongside the status.
  let lastStatus: GitStatusResult | null = null

  function getProject() {
    const projectStore = useProjectStore()
    return projectStore.currentProject
  }

  // The active worktree root (single source of truth in the project store).
  // Callers guard on getProject() first, so this is always a real path.
  function getRoot(): string {
    return useProjectStore().activeRoot
  }

  async function doRefreshStatus(showProgress: boolean): Promise<void> {
    const project = getProject()
    if (!project) return
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise((r) => setTimeout(r, 300)) : null
    try {
      const [s] = await Promise.all([gitStatus(getRoot(), project.shell), minDelay])
      status.value = s
      error.value = null
      isRepo.value = true
      // Auto-refresh the commit log when the repo's commit state changed since
      // the last poll. Skip the very first observation to avoid a redundant
      // load (the panel loads the log explicitly on open).
      if (
        lastStatus &&
        (s.head !== lastStatus.head || s.ahead !== lastStatus.ahead || s.behind !== lastStatus.behind)
      ) {
        void refreshLog()
      }
      lastStatus = s
    } catch (e) {
      // A status failure is usually "not a git repository" — disambiguate so the
      // panel can offer to initialize one instead of showing a raw git error.
      const repo = await gitIsRepo(getRoot(), project.shell).catch(() => true)
      if (!repo) {
        isRepo.value = false
        status.value = null
        error.value = null
      } else {
        isRepo.value = true
        error.value = String(e)
      }
      if (minDelay) await minDelay
    } finally {
      refreshing.value = false
    }
  }

  // Coalescing wrapper: keeps at most one in-flight + one pending refresh.
  // Callers that arrive while a refresh is running get scheduled into the
  // pending slot so post-action state is never silently dropped.
  async function refreshStatus(showProgress = false): Promise<void> {
    if (statusInFlight) {
      if (statusPending) return statusPending
      statusPending = statusInFlight
        .then(() => doRefreshStatus(showProgress))
        .finally(() => {
          statusPending = null
        })
      return statusPending
    }
    statusInFlight = doRefreshStatus(showProgress).finally(() => {
      statusInFlight = null
    })
    return statusInFlight
  }

  async function doRefreshLog(): Promise<void> {
    const project = getProject()
    if (!project) return
    try {
      logEntries.value = await gitLog(getRoot(), project.shell, logAllMode.value ? 1000 : 500, logAllMode.value)
    } catch {
      logEntries.value = []
    }
  }

  async function refreshLog(all?: boolean): Promise<void> {
    if (all !== undefined) logAllMode.value = all
    if (logInFlight) {
      if (logPending) return logPending
      logPending = logInFlight
        .then(() => doRefreshLog())
        .finally(() => {
          logPending = null
        })
      return logPending
    }
    logInFlight = doRefreshLog().finally(() => {
      logInFlight = null
    })
    return logInFlight
  }

  async function stageFiles(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitStage(getRoot(), project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function unstageFiles(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitUnstage(getRoot(), project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function discardChanges(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitDiscardChanges(getRoot(), project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function commitChanges(message: string) {
    const project = getProject()
    if (!project) return
    try {
      await gitCommit(getRoot(), project.shell, message)
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
    }
  }

  async function push(options?: PushOption[]) {
    const project = getProject()
    // **ガードはここに置く**（#270）。以前は SideBar のボタンの disabled だけが多重実行を
    // 止めていたので、パレットから 2 回叩くと同じリポジトリで 2 本走り、`index.lock` で
    // ぶつかったうえ、先に終わったほうがフラグを戻していた。
    if (!project || pushing.value) return
    pushing.value = true
    try {
      await gitPush(getRoot(), project.shell, options)
      await refreshStatus()
    } catch (e) {
      setError(String(e))
    } finally {
      pushing.value = false
    }
  }

  async function pull(options?: PullOption[]) {
    const project = getProject()
    if (!project || pulling.value) return
    pulling.value = true
    let failure: string | null = null
    try {
      await gitPull(getRoot(), project.shell, options)
    } catch (e) {
      failure = String(e)
    } finally {
      // Refresh either way: a pull that stopped on a conflict rejects, and its
      // conflicts and the operation banner are exactly what the user needs to
      // see now rather than after the next poll (#222).
      await Promise.all([refreshStatus(), refreshLog()])
      // ...and set the error only after, since a successful refresh clears it.
      if (failure) setError(failure)
      pulling.value = false
    }
  }

  /**
   * Run a recovery command for the stopped operation in a terminal tab, the way
   * the task runner and compose do. Not a backend command on purpose:
   * `git rebase --continue` opens $EDITOR, signing can raise a passphrase or
   * 1Password prompt, and the backend's git calls have no TTY and die at 30s.
   */
  async function runRecovery(command: string) {
    const project = getProject()
    if (!project) return
    // The operation may have finished in another terminal since the last poll.
    await refreshStatus()
    if (!status.value?.operation?.canContinue) return
    useTabStore().runCommandTab(command, getRoot(), project.shell, {
      keepOnError: true,
      onExit: () => {
        void refreshStatus()
        void refreshLog()
      },
    })
  }

  /**
   * Carry the stopped operation forward. A rebase that could not write its
   * commit (signing, a hook) has to be handed that commit first: `git rebase
   * --continue` refuses the state outright. `-C` keeps the original author and
   * author date, which a plain re-commit would silently reset to now.
   *
   * Both commands are assembled from values the backend vouches for — `kind` is
   * one of its own literals and `stoppedSha` passed `is_sha` — so nothing here
   * needs quoting. Anything new interpolated into these lines does.
   */
  async function continueOperation() {
    const op = status.value?.operation
    if (!op?.canContinue) return
    // git refuses `--continue` while anything is still unmerged; the panel
    // disables the button for this, and the guard keeps other callers honest.
    if (status.value?.conflicted.length) return
    if (op.stop !== 'commit-failed' || !op.stoppedSha) {
      await runRecovery(`git ${op.kind} --continue`)
      return
    }
    // Two commands, and the second must not run if the commit failed again
    // (the signing prompt was dismissed, say) — so chain in the shell's syntax.
    const shell = getProject()?.shell
    const command = chainOnSuccess(`git commit -C ${op.stoppedSha}`, `git ${op.kind} --continue`, shell)
    const subject = op.stoppedSubject || op.stoppedSha.slice(0, 8)
    if (!(await confirmDialog(t('git.recommitConfirm', { subject, command })))) return
    await runRecovery(command)
  }

  async function abortOperation() {
    const op = status.value?.operation
    if (!op?.canContinue) return
    const command = `git ${op.kind} --abort`
    if (!(await confirmDialog(t('git.abortConfirm', { command })))) return
    await runRecovery(command)
  }

  async function loadBranches() {
    const project = getProject()
    if (!project) return
    try {
      const list = await gitBranchList(getRoot(), project.shell)
      branches.value = list.local
      remoteBranches.value = list.remote
    } catch {
      branches.value = []
      remoteBranches.value = []
    }
  }

  /**
   * Update the remote-tracking refs before reloading the list, so the switcher
   * offers branches pushed since the last fetch (#197). Reuses the throttled
   * background fetch: opening the switcher right after a poll costs no network.
   */
  async function refreshRemoteBranches() {
    fetchingBranches.value = true
    try {
      await fetchInBackground()
      await loadBranches()
    } finally {
      fetchingBranches.value = false
    }
  }

  async function loadRemoteUrl() {
    const project = getProject()
    if (!project) {
      remoteUrl.value = null
      return
    }
    const root = getRoot()
    try {
      remoteUrl.value = await gitRemoteUrl(root, project.shell)
    } catch {
      remoteUrl.value = null
    }
    // Persist origin on the project so a machine that lacks the checkout can
    // still clone it (#164). Only for the project's own root — a worktree can
    // sit in another repository. Never clears a stored URL from a transient
    // failure: only an actual URL change writes.
    //
    // **`root === project.root` の文字列比較にしないこと（#303）。** `activeRoot` は
    // 末尾の区切りを落とした値を配るので、`/home/kan/proj/` の形で登録されている
    // プロジェクトでは永久に一致せず、origin が黙って記録されなくなる。聞きたいのは
    // 「worktree に居るか」なので、そのものを見る。
    const url = remoteUrl.value
    const projectStore = useProjectStore()
    if (url && projectStore.activeWorktreeRoot === null && project.remoteUrl !== url) {
      projectStore.saveProject({ ...project, remoteUrl: url }).catch(() => {})
    }
  }

  async function initRepo() {
    const project = getProject()
    if (!project) return
    try {
      await gitInit(getRoot(), project.shell)
      isRepo.value = true
      error.value = null
      lastStatus = null
      await Promise.all([refreshStatus(), refreshLog()])
      await loadRemoteUrl()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function checkoutBranch(branch: string) {
    const project = getProject()
    if (!project) return
    try {
      await gitCheckout(getRoot(), project.shell, branch)
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
    }
  }

  /**
   * Switch to a remote-tracking branch, creating the local branch that tracks it.
   * When that local branch already exists (the list was stale, or the switcher
   * showed the remote anyway), switch to it instead of failing on `--track`.
   */
  async function checkoutRemoteBranch(remoteBranch: string) {
    const local = localBranchName(remoteBranch)
    if (branches.value.includes(local)) return checkoutBranch(local)
    const project = getProject()
    if (!project) return
    try {
      await gitCheckoutTrack(getRoot(), project.shell, remoteBranch)
      // The new local branch has to show up in the switcher's local list.
      await Promise.all([refreshStatus(), refreshLog(), loadBranches()])
    } catch (e) {
      error.value = String(e)
    }
  }

  async function fetchInBackground() {
    if (fetchGuard) return
    if (!windowFocused.value) return
    const elapsed = Date.now() - lastFetchTime
    if (lastFetchTime > 0 && elapsed < 60_000) return
    // Likely resumed from sleep — defer until next normal cycle
    if (lastFetchTime > 0 && elapsed > 300_000) {
      lastFetchTime = Date.now()
      return
    }
    const project = getProject()
    if (!project) return
    fetchGuard = true
    try {
      await gitFetch(getRoot(), project.shell)
      lastFetchTime = Date.now()
      await refreshStatus()
    } catch {
      // Silently ignore fetch errors (offline, auth failure, etc.)
    } finally {
      fetchGuard = false
    }
  }

  const polling = useFocusPolling([
    { every: 10_000, tick: refreshStatus },
    { every: 60_000, tick: fetchInBackground },
  ])

  function startPolling() {
    lastStatus = null
    // Restarted on every project switch (App.vue), so fetch once up front: the
    // timer alone would leave the StatusBar showing the previous project's
    // branch and ahead/behind for up to 10 seconds. `refreshStatus` dedups, so
    // an open Git panel refreshing at the same time costs nothing extra.
    refreshStatus()
    loadRemoteUrl()
    polling.start()
  }

  return {
    status,
    logEntries,
    branches,
    remoteBranches,
    fetchingBranches,
    remoteUrl,
    error,
    isRepo,
    pushing,
    pulling,
    refreshing,
    refreshStatus,
    refreshAll,
    refreshLog,
    stageFiles,
    unstageFiles,
    discardChanges,
    commitChanges,
    push,
    pull,
    continueOperation,
    abortOperation,
    loadBranches,
    refreshRemoteBranches,
    loadRemoteUrl,
    initRepo,
    checkoutBranch,
    checkoutRemoteBranch,
    fetchInBackground,
    startPolling,
    stopPolling: polling.stop,
  }
})
