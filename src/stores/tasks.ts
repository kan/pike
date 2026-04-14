import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { pathSep } from '../lib/paths'
import { fsReadFile, taskListMakefileTargets } from '../lib/tauri'
import type { TaskDefinition, TaskGroup, TaskRunner } from '../types/tasks'
import { RUNNER_COMMANDS } from '../types/tasks'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

function parsePackageJson(content: string): TaskDefinition[] {
  try {
    const pkg = JSON.parse(content)
    const scripts = pkg.scripts as Record<string, string> | undefined
    if (!scripts) return []
    return Object.entries(scripts).map(([name, command]) => ({
      name,
      command: command as string,
      runner: 'npm' as TaskRunner,
    }))
  } catch {
    return []
  }
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseDenoJson(content: string): TaskDefinition[] {
  try {
    const deno = JSON.parse(stripJsonComments(content))
    const tasks = deno.tasks as Record<string, string> | undefined
    if (!tasks) return []
    return Object.entries(tasks)
      .filter(([, v]) => typeof v === 'string')
      .map(([name, command]) => ({
        name,
        command: command as string,
        runner: 'deno' as TaskRunner,
      }))
  } catch {
    return []
  }
}

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
    const sep = pathSep(project.shell)
    const root = project.root
    const shell = project.shell

    const [npmResult, denoResult, makeResult] = await Promise.allSettled([
      fsReadFile(shell, `${root}${sep}package.json`).then((r) => {
        const tasks = parsePackageJson(r.content)
        if (tasks.length > 0)
          return { runner: 'npm' as TaskRunner, label: 'npm scripts', sourceFile: 'package.json', tasks }
        return null
      }),
      fsReadFile(shell, `${root}${sep}deno.json`)
        .catch(() => fsReadFile(shell, `${root}${sep}deno.jsonc`))
        .then((r) => {
          const tasks = parseDenoJson(r.content)
          if (tasks.length > 0)
            return { runner: 'deno' as TaskRunner, label: 'deno tasks', sourceFile: 'deno.json', tasks }
          return null
        }),
      taskListMakefileTargets(shell, root).then((targets) => {
        if (targets.length > 0)
          return {
            runner: 'make' as TaskRunner,
            label: 'make targets',
            sourceFile: 'Makefile',
            tasks: targets.map((t) => ({ name: t.name, command: t.name, runner: 'make' as TaskRunner })),
          }
        return null
      }),
    ])

    const groups: TaskGroup[] = []
    for (const r of [npmResult, denoResult, makeResult]) {
      if (r.status === 'fulfilled' && r.value) groups.push(r.value)
    }

    taskGroups.value = groups
    loading.value = false
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  function runTask(task: TaskDefinition) {
    const project = useProjectStore().currentProject
    if (!project) return
    const command = RUNNER_COMMANDS[task.runner](task.name)
    useTabStore().addTerminalTab({ title: command, autoStart: command, cwd: project.root })
  }

  const allTasks = computed(() => taskGroups.value.flatMap((g) => g.tasks))

  return { taskGroups, loading, refresh, runTask, allTasks }
})
