import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProjectConfig } from '../types/project'
import {
  projectList,
  projectCreate,
  projectUpdate,
  projectDelete,
  projectGetLast,
  projectSetLast,
} from '../lib/tauri'
import { useTabStore } from './tabs'
import { useSearchStore } from './search'

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectConfig[]>([])
  const currentProject = ref<ProjectConfig | null>(null)
  const showSwitcher = ref(false)

  async function loadProjects() {
    projects.value = await projectList()
  }

  async function restoreLastProject() {
    await loadProjects()
    const lastId = await projectGetLast().catch(() => null)
    if (lastId) {
      const project = projects.value.find((p) => p.id === lastId)
      if (project) {
        await switchProject(project.id)
        return
      }
    }
    // No last project — open switcher to prompt user
    if (projects.value.length > 0) {
      showSwitcher.value = true
    }
  }

  async function switchProject(id: string) {
    const tabStore = useTabStore()
    const searchStore = useSearchStore()
    const project = projects.value.find((p) => p.id === id)
    if (!project) return

    searchStore.clear()
    searchStore.backend = null

    await tabStore.clearAllTabs()

    project.lastOpened = new Date().toISOString()
    await Promise.all([
      projectUpdate(project).catch(() => {}),
      projectSetLast(id).catch(() => {}),
    ])

    currentProject.value = project

    for (const def of project.pinnedTabs) {
      tabStore.addTerminalTab({
        id: def.id,
        title: def.title,
        pinned: true,
        autoStart: def.autoStart,
        cwd: project.root,
        shell: project.shell,
      })
    }

    if (project.pinnedTabs.length === 0) {
      tabStore.addTerminalTab({
        id: 'cc',
        title: 'Claude Code',
        pinned: true,
        autoStart: 'claude',
        cwd: project.root,
        shell: project.shell,
      })
    }
  }

  async function addProject(config: ProjectConfig) {
    const created = await projectCreate(config)
    projects.value.unshift(created)
  }

  async function saveProject(config: ProjectConfig) {
    await projectUpdate(config)
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) {
      projects.value[idx] = config
    }
    if (currentProject.value?.id === config.id) {
      currentProject.value = config
    }
  }

  async function removeProject(id: string) {
    await projectDelete(id)
    projects.value = projects.value.filter((p) => p.id !== id)
    if (currentProject.value?.id === id) {
      currentProject.value = null
    }
  }

  function toggleSwitcher() {
    showSwitcher.value = !showSwitcher.value
  }

  return {
    projects,
    currentProject,
    showSwitcher,
    loadProjects,
    restoreLastProject,
    switchProject,
    addProject,
    saveProject,
    removeProject,
    toggleSwitcher,
  }
})
