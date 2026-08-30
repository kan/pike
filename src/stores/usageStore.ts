import { defineStore } from 'pinia'
import { type Ref, ref, watch } from 'vue'
import { useFocusPolling } from '../composables/useFocusPolling'
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
  /**
   * 結果が参照ルートに依存するか（既定は true）。`true` なら worktree / プロジェクトの
   * 切り替えで取り直し、取得中に変わった結果は捨てる。**レートだけが `false`**: あれは
   * アカウント単位で、`project_root` はコマンドを流すシェルを選ぶためにしか使わないので、
   * 同じプロジェクトのどの worktree でも答えは変わらない。切り替えのたびに `claude -p
   * "/usage"` を捨てて取り直す理由がない。
   */
  rootScoped = true,
) {
  return defineStore(id, () => {
    const usage = ref<T | null>(null) as Ref<T | null>
    /**
     * A **manual** refresh is in flight. Reactive (unlike the guard below) because
     * more than one view spins for the same click — the status bar and the agent
     * status tab both drive `refreshUsage(true)`.
     *
     * Background polls deliberately don't set it: the refresh button would then
     * disable itself every 30s with no user action (and for the rate store, a
     * cache-miss fetch can run 90s).
     */
    const refreshing = ref(false)

    let refreshGuard = false

    /** `force` is forwarded to the fetcher (cache-bypass for backends that cache). */
    async function refreshUsage(force = false) {
      if (refreshGuard) return
      const projectStore = useProjectStore()
      refreshGuard = true
      if (force) refreshing.value = true
      try {
        for (;;) {
          const project = projectStore.currentProject
          // 集計はセッションの cwd と root の一致で行うので、ターミナルとエージェントが
          // 開く場所（= `activeRoot`）を渡す。worktree で作業しているあいだ
          // `project.root` を渡すと、どのセッションも一致せず利用量が 0 に見える（#269）。
          const root = projectStore.activeRoot
          if (!project || !root) return
          const result = await fetcher(project.shell, root, force)
          // 取得中に参照先が変わったら、この結果は前の root のものなので捨てて取り直す。
          // 切り替え側から来る refresh は `refreshGuard` に弾かれているので、ここで
          // 拾わないと次のポーリングまで前の数字が残る。
          if (rootScoped && projectStore.activeRoot !== root) continue
          if (usage.value && JSON.stringify(usage.value) === JSON.stringify(result)) return
          usage.value = result
          return
        }
      } catch {
        // Silently ignore errors (tool not installed, no sessions, etc.)
      } finally {
        refreshGuard = false
        refreshing.value = false
      }
    }

    // 参照ルートが変わったら取り直す（#269）。**呼び出し側に配らないこと**: 以前は
    // worktree の切り替えが 2 つの store を名指しで叩いていて、「どの usage が root に
    // 依存するか」の知識があちらとここに二重にあった。ここに置けば、store を増やしても
    // 追従は付いてくる。
    if (rootScoped) {
      watch(
        () => useProjectStore().activeRoot,
        () => void refreshUsage(),
      )
    }

    const polling = useFocusPolling([{ every: 30_000, tick: () => refreshUsage() }])

    function startPolling() {
      // プロジェクト切替のたびに張り直されるので、前のプロジェクトの数字を先に捨てる
      // （`git` の `lastStatus` と同じ理由。取得が返るまで StatusBar に残ってしまう）。
      usage.value = null
      refreshUsage()
      polling.start()
    }

    function stopPolling() {
      polling.stop()
      usage.value = null
    }

    return { usage, refreshing, refreshUsage, startPolling, stopPolling }
  })
}
