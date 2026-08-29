import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { basename, joinPath, pathSep } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import { taskDiscover } from '../lib/tauri'
import type { TaskDefinition, TaskGroup, TaskRunner } from '../types/tasks'
import { RUNNER_COMMANDS } from '../types/tasks'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

export const useTaskStore = defineStore('tasks', () => {
  const taskGroups = ref<TaskGroup[]>([])
  const loading = ref(false)
  let refreshPromise: Promise<void> | null = null

  /**
   * 畳んであるグループ（`sourceFile` の集合、#273）。**キーはプロジェクトごとに分ける**
   * （`fileTree` の `expanded` と同型）。`sourceFile` はルート相対なので、1 つのキーに
   * 全プロジェクトを入れると別プロジェクトの `package.json` と衝突するうえ、他のウィンドウが
   * 書いた分を読み直してから差し替える必要が出る。
   */
  const collapsedGroups = ref<Set<string>>(new Set())
  let collapsedProjectId: string | null = null

  function collapseKey(projectId: string): string {
    return `pike:tasks-collapsed:${projectId}`
  }

  /** 表示側が呼ぶ。プロジェクトが変わっていれば読み直す。 */
  function loadCollapsed(projectId: string) {
    if (collapsedProjectId === projectId) return
    collapsedProjectId = projectId
    const saved = loadJson<unknown>(collapseKey(projectId), [])
    collapsedGroups.value = new Set(Array.isArray(saved) ? (saved as string[]) : [])
  }

  function toggleCollapsed(sourceFile: string) {
    const next = new Set(collapsedGroups.value)
    if (!next.delete(sourceFile)) next.add(sourceFile)
    collapsedGroups.value = next
    if (collapsedProjectId) saveJson(collapseKey(collapsedProjectId), [...next])
  }

  async function doRefresh() {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) {
      taskGroups.value = []
      return
    }

    loading.value = true
    try {
      const groups = await taskDiscover(project.shell, projectStore.activeRoot)
      taskGroups.value = groups.map((g) => ({
        runner: g.runner as TaskRunner,
        label: g.label,
        sourceFile: g.sourceFile,
        cwd: g.cwd,
        tasks: g.tasks.map((t) => ({
          name: t.name,
          command: t.command,
          description: t.description ?? undefined,
          runner: t.runner as TaskRunner,
        })),
      }))
    } catch {
      taskGroups.value = []
    } finally {
      loading.value = false
    }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  function runTask(task: TaskDefinition, group?: TaskGroup) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) return
    const command = RUNNER_COMMANDS[task.runner](task.name)
    const cwd = group?.cwd ?? task.cwd ?? projectStore.activeRoot
    useTabStore().runCommandTab(command, cwd, project.shell)
  }

  /** Open a group's task-definition file (package.json etc.) in an editor tab. */
  function openSourceFile(group: TaskGroup) {
    const project = useProjectStore().currentProject
    if (!project) return
    // sourceFile is root-relative; cwd is the absolute directory of the file
    const path = joinPath(group.cwd, basename(group.sourceFile), pathSep(project.shell))
    useTabStore().addEditorTab({ path })
  }

  /**
   * Drop the discovered groups. Called on project switch (`switchProject`) like
   * the search and diagnostics stores: discovery walks the project tree, so it
   * is re-run lazily by whoever asks next (the panel, the palette's `>` mode)
   * rather than during the switch. Without it both surfaces keep listing the
   * previous project's tasks — and running one would launch it in that
   * project's directory.
   */
  function clear() {
    taskGroups.value = []
  }

  const allTasks = computed(() =>
    taskGroups.value.flatMap((g) => g.tasks.map((t) => ({ ...t, cwd: g.cwd, groupLabel: g.label }))),
  )

  return {
    taskGroups,
    loading,
    collapsedGroups,
    loadCollapsed,
    toggleCollapsed,
    refresh,
    clear,
    runTask,
    openSourceFile,
    allTasks,
  }
})
