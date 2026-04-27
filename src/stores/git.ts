import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  gitBranchList,
  gitCheckout,
  gitCommit,
  gitDiscardChanges,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../lib/tauri'
import type { GitLogEntry, GitStatusResult } from '../types/git'
import { useProjectStore } from './project'

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const branches = ref<string[]>([])
  const error = ref<string | null>(null)
  const pushing = ref(false)
  const pulling = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let fetchTimer: ReturnType<typeof setInterval> | null = null
  let pollAbort: AbortController | null = null
  const refreshing = ref(false)
  let statusInFlight: Promise<void> | null = null
  let statusPending: Promise<void> | null = null
  let logInFlight: Promise<void> | null = null
  let logPending: Promise<void> | null = null
  let fetchGuard = false
  let lastFetchTime = 0
  let windowFocused = true
  const logAllMode = ref(false)

  function getProject() {
    const projectStore = useProjectStore()
    return projectStore.currentProject
  }

  async function doRefreshStatus(showProgress: boolean): Promise<void> {
    const project = getProject()
    if (!project) return
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise((r) => setTimeout(r, 300)) : null
    try {
      const [s] = await Promise.all([gitStatus(project.root, project.shell), minDelay])
      status.value = s
      error.value = null
    } catch (e) {
      error.value = String(e)
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
      logEntries.value = await gitLog(project.root, project.shell, logAllMode.value ? 1000 : 500, logAllMode.value)
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
      await gitStage(project.root, project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function unstageFiles(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitUnstage(project.root, project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function discardChanges(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitDiscardChanges(project.root, project.shell, paths)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    }
  }

  async function commitChanges(message: string) {
    const project = getProject()
    if (!project) return
    try {
      await gitCommit(project.root, project.shell, message)
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
    }
  }

  async function push() {
    const project = getProject()
    if (!project) return
    pushing.value = true
    try {
      await gitPush(project.root, project.shell)
      await refreshStatus()
    } catch (e) {
      error.value = String(e)
    } finally {
      pushing.value = false
    }
  }

  async function pull() {
    const project = getProject()
    if (!project) return
    pulling.value = true
    try {
      await gitPull(project.root, project.shell)
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
    } finally {
      pulling.value = false
    }
  }

  async function loadBranches() {
    const project = getProject()
    if (!project) return
    try {
      branches.value = await gitBranchList(project.root, project.shell)
    } catch {
      branches.value = []
    }
  }

  async function checkoutBranch(branch: string) {
    const project = getProject()
    if (!project) return
    try {
      await gitCheckout(project.root, project.shell, branch)
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
    }
  }

  async function fetchInBackground() {
    if (fetchGuard) return
    if (!windowFocused) return
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
      await gitFetch(project.root, project.shell)
      lastFetchTime = Date.now()
      await refreshStatus()
    } catch {
      // Silently ignore fetch errors (offline, auth failure, etc.)
    } finally {
      fetchGuard = false
    }
  }

  function startTimers() {
    clearTimers()
    pollTimer = setInterval(refreshStatus, 10000)
    fetchTimer = setInterval(fetchInBackground, 60000)
  }

  function clearTimers() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (fetchTimer) {
      clearInterval(fetchTimer)
      fetchTimer = null
    }
  }

  function startPolling() {
    stopPolling()
    windowFocused = document.hasFocus()
    if (windowFocused) startTimers()
    pollAbort = new AbortController()
    const { signal } = pollAbort
    window.addEventListener(
      'blur',
      () => {
        windowFocused = false
        clearTimers()
      },
      { signal },
    )
    window.addEventListener(
      'focus',
      () => {
        windowFocused = true
        refreshStatus()
        startTimers()
      },
      { signal },
    )
  }

  function stopPolling() {
    clearTimers()
    pollAbort?.abort()
    pollAbort = null
  }

  return {
    status,
    logEntries,
    branches,
    error,
    pushing,
    pulling,
    refreshing,
    refreshStatus,
    refreshLog,
    stageFiles,
    unstageFiles,
    discardChanges,
    commitChanges,
    push,
    pull,
    loadBranches,
    checkoutBranch,
    fetchInBackground,
    startPolling,
    stopPolling,
  }
})
