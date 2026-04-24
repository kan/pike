import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { taskDiscover } from '../lib/tauri'
import type { TaskDefinition, TaskGroup, TaskRunner } from '../types/tasks'
import { RUNNER_COMMANDS } from '../types/tasks'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

export const useTaskStore = defineStore('tasks', () => {
  const taskGroups = ref<TaskGroup[]>([])
  const loading = ref(false)
  let refreshPromise: Promise<void> | null = null

  async function doRefresh() {
    const project = useProjectStore().currentProject
    if (!project) {
      taskGroups.value = []
      return
    }

    loading.value = true
    try {
      const groups = await taskDiscover(project.shell, project.root)
      taskGroups.value = groups.map((g) => ({
        runner: g.runner as TaskRunner,
        label: g.label,
        sourceFile: g.sourceFile,
        cwd: g.cwd,
        tasks: g.tasks.map((t) => ({
          name: t.name,
          command: t.command,
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
    const project = useProjectStore().currentProject
    if (!project) return
    const command = RUNNER_COMMANDS[task.runner](task.name)
    const cwd = group?.cwd ?? task.cwd ?? project.root
    useTabStore().addTerminalTab({
      title: command,
      autoStart: command,
      closeOnExit: true,
      cwd,
      shell: project.shell,
    })
  }

  const allTasks = computed(() => taskGroups.value.flatMap((g) => g.tasks.map((t) => ({ ...t, cwd: g.cwd }))))

  return { taskGroups, loading, refresh, runTask, allTasks }
})
