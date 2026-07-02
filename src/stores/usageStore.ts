import { defineStore } from 'pinia'
import { type Ref, ref } from 'vue'
import type { ShellType } from '../types/tab'
import { useProjectStore } from './project'

/**
 * Factory for a token-usage polling store (Claude / Codex). Polls `fetcher`
 * every 30s while the window is focused, plus once on focus regain; stops on
 * blur. The fetched result replaces `usage` only when it actually changed
 * (deep-compared across *all* fields, so secondary fields like rate-limit % or
 * cached/reasoning tokens repaint even when the headline token totals are equal).
 */
export function createUsageStore<T extends { active: boolean }>(
  id: string,
  fetcher: (shell: ShellType, projectRoot: string, force?: boolean) => Promise<T>,
) {
  return defineStore(id, () => {
    const usage = ref<T | null>(null) as Ref<T | null>

    let pollTimer: ReturnType<typeof setInterval> | null = null
    let pollAbort: AbortController | null = null
    let refreshGuard = false
    let windowFocused = true

    function getProject() {
      return useProjectStore().currentProject ?? null
    }

    /** `force` is forwarded to the fetcher (cache-bypass for backends that cache). */
    async function refreshUsage(force = false) {
      if (refreshGuard) return
      const project = getProject()
      if (!project?.root) return
      refreshGuard = true
      try {
        const result = await fetcher(project.shell, project.root, force)
        if (usage.value && JSON.stringify(usage.value) === JSON.stringify(result)) {
          return
        }
        usage.value = result
      } catch {
        // Silently ignore errors (tool not installed, no sessions, etc.)
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
}
