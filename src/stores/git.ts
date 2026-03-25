import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GitStatusResult, GitLogEntry } from '../types/git'
import {
  gitStatus,
  gitLog,
  gitStage,
  gitUnstage,
  gitCommit,
  gitBranchList,
  gitCheckout,
  gitPush,
  gitPull,
} from '../lib/tauri'
import { useProjectStore } from './project'
import { useSettingsStore } from './settings'

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const branches = ref<string[]>([])
  const error = ref<string | null>(null)
  const pushing = ref(false)
  const pulling = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  const refreshing = ref(false)
  let refreshGuard = false

  function getProject() {
    const projectStore = useProjectStore()
    return projectStore.currentProject
  }

  async function refreshStatus(showProgress = false) {
    if (refreshGuard) return
    const project = getProject()
    if (!project) return
    refreshGuard = true
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise(r => setTimeout(r, 300)) : null
    try {
      const [s] = await Promise.all([gitStatus(project.root, project.shell), minDelay])
      status.value = s
      error.value = null
    } catch (e) {
      error.value = String(e)
      if (minDelay) await minDelay
    } finally {
      refreshGuard = false
      refreshing.value = false
    }
  }

  async function refreshLog() {
    const project = getProject()
    if (!project) return
    try {
      logEntries.value = await gitLog(project.root, project.shell, 50)
    } catch {
      logEntries.value = []
    }
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
      const ssh = useSettingsStore().sshCommand || undefined
      await gitPush(project.root, project.shell, ssh)
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
      const ssh = useSettingsStore().sshCommand || undefined
      await gitPull(project.root, project.shell, ssh)
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

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(refreshStatus, 4000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
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
    commitChanges,
    push,
    pull,
    loadBranches,
    checkoutBranch,
    startPolling,
    stopPolling,
  }
})
