import { defineStore } from 'pinia'
import { ref } from 'vue'
import { claudeUsageGet } from '../lib/tauri'
import type { ClaudeUsageResult } from '../types/claudeUsage'
import { useProjectStore } from './project'

export const useClaudeUsageStore = defineStore('claudeUsage', () => {
  const usage = ref<ClaudeUsageResult | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollAbort: AbortController | null = null
  let refreshGuard = false
  let windowFocused = true

  function getProject() {
    return useProjectStore().currentProject ?? null
  }

  async function refreshUsage() {
    if (refreshGuard) return
    const project = getProject()
    if (!project?.root) return
    refreshGuard = true
    try {
      const result = await claudeUsageGet(project.shell, project.root)
      const prev = usage.value
      if (
        prev &&
        prev.active === result.active &&
        prev.totalInputTokens === result.totalInputTokens &&
        prev.totalOutputTokens === result.totalOutputTokens
      ) {
        return
      }
      usage.value = result
    } catch {
      // Silently ignore errors (Claude not installed, no sessions, etc.)
    } finally {
      refreshGuard = false
    }
  }

  function startTimers() {
    clearTimers()
    pollTimer = setInterval(refreshUsage, 30_000)
  }

  function clearTimers() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function startPolling() {
    stopPolling()
    windowFocused = document.hasFocus()
    refreshUsage()
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
        refreshUsage()
        startTimers()
      },
      { signal },
    )
  }

  function stopPolling() {
    clearTimers()
    pollAbort?.abort()
    pollAbort = null
    usage.value = null
  }

  return { usage, refreshUsage, startPolling, stopPolling }
})
