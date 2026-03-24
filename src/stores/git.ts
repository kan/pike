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

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const branches = ref<string[]>([])
  const error = ref<string | null>(null)
  const pushing = ref(false)
  const pulling = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let refreshing = false

  function getProject() {
    const projectStore = useProjectStore()
    return projectStore.currentProject
  }

  async function refreshStatus() {
    if (refreshing) return
    const project = getProject()
    if (!project) return
    refreshing = true
    try {
      status.value = await gitStatus(project.root, project.shell)
      error.value = null
    } catch (e) {
      error.value = String(e)
    } finally {
      refreshing = false
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
