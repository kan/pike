import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GitStatusResult, GitLogEntry } from '../types/git'
import {
  gitStatus,
  gitLog,
  gitDiff,
  gitStage,
  gitUnstage,
  gitCommit,
  gitBranchList,
  gitCheckout,
} from '../lib/tauri'
import { useProjectStore } from './project'

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const selectedDiff = ref<{ path: string; staged: boolean; diff: string } | null>(null)
  const branches = ref<string[]>([])
  const error = ref<string | null>(null)

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

  async function loadDiff(path: string, staged: boolean) {
    const project = getProject()
    if (!project) return
    if (selectedDiff.value?.path === path && selectedDiff.value?.staged === staged) {
      selectedDiff.value = null
      return
    }
    try {
      const diff = await gitDiff(project.root, project.shell, path, staged)
      selectedDiff.value = { path, staged, diff }
    } catch (e) {
      selectedDiff.value = { path, staged, diff: String(e) }
    }
  }

  async function stageFiles(paths: string[]) {
    const project = getProject()
    if (!project) return
    try {
      await gitStage(project.root, project.shell, paths)
      selectedDiff.value = null
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
      selectedDiff.value = null
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
      selectedDiff.value = null
      await Promise.all([refreshStatus(), refreshLog()])
    } catch (e) {
      error.value = String(e)
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
    selectedDiff,
    branches,
    error,
    refreshStatus,
    refreshLog,
    loadDiff,
    stageFiles,
    unstageFiles,
    commitChanges,
    loadBranches,
    checkoutBranch,
    startPolling,
    stopPolling,
  }
})
