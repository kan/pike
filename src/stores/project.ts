import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  openProjectWindow,
  projectAddOpen,
  projectCreate,
  projectDelete,
  projectGetLast,
  projectList,
  projectSetLast,
  projectUpdate,
} from '../lib/tauri'
import type { ProjectConfig } from '../types/project'
import { useSearchStore } from './search'
import { useSettingsStore } from './settings'
import { useTabStore } from './tabs'

const RESUME_MAP: Record<string, string> = {
  claude: 'claude --continue',
}

function resolveResumeCommand(autoStart?: string): string | undefined {
  if (!autoStart) return undefined
  return RESUME_MAP[autoStart] ?? autoStart
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectConfig[]>([])
  const currentProject = ref<ProjectConfig | null>(null)
  const showSwitcher = ref(false)
  const showQuickOpen = ref(false)

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function loadProjects() {
    projects.value = await projectList()
  }

  async function restoreLastProject() {
    await loadProjects()
    const lastIds = await projectGetLast().catch(() => [] as string[])
    // Clear the list immediately; each window re-adds itself via projectAddOpen
    projectSetLast([]).catch(() => {})
    if (lastIds.length > 0) {
      // Main window opens the first project
      const mainId = lastIds[0]
      if (projects.value.find((p) => p.id === mainId)) {
        await switchProject(mainId)
      }
      // Remaining projects open in separate windows
      for (const id of lastIds.slice(1)) {
        if (projects.value.find((p) => p.id === id)) {
          openProjectWindow(id).catch(() => {})
        }
      }
      return
    }
    if (projects.value.length > 0) {
      showSwitcher.value = true
    }
  }

  async function switchProject(id: string) {
    if (saveTimer) clearTimeout(saveTimer)
    const tabStore = useTabStore()
    const searchStore = useSearchStore()
    const project = projects.value.find((p) => p.id === id)
    if (!project) return

    searchStore.clear()
    searchStore.backend = null

    await tabStore.clearAllTabs()

    project.lastOpened = new Date().toISOString()
    currentProject.value = project

    // Fire-and-forget: don't block tab restoration on metadata persistence
    Promise.all([projectUpdate(project).catch(() => {}), projectAddOpen(id).catch(() => {})])

    if (project.lastSession && project.lastSession.tabs.length > 0) {
      for (const def of project.lastSession.tabs) {
        if (def.kind === 'terminal') {
          tabStore.addTerminalTab({
            id: def.id,
            title: def.title,
            pinned: def.pinned,
            autoStart: def.pinned ? resolveResumeCommand(def.autoStart) : undefined,
            cwd: project.root,
            shell: project.shell,
          })
        } else if (def.kind === 'editor') {
          if (def.path) {
            tabStore.addEditorTab({ path: def.path })
          } else if (def.content !== undefined) {
            tabStore.addBlankEditorTab({ title: def.title, content: def.content })
          }
        } else if (def.kind === 'codex-chat' || def.kind === 'agent-chat') {
          const settings = useSettingsStore()
          const agentType =
            (def.agentType as 'codex' | 'claude-code') ??
            (settings.agentDefault === 'ask' ? 'claude-code' : settings.agentDefault)
          tabStore.addAgentChatTab({ pinned: def.pinned, agentType })
        }
      }
      if (project.lastSession.activeTabId) {
        tabStore.setActiveTab(project.lastSession.activeTabId)
      }
    } else {
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

    // Ensure at least one plain terminal tab exists (for CWD detection, etc.)
    const hasPlainTerminal = tabStore.tabs.some((t) => t.kind === 'terminal' && !t.autoStart)
    if (!hasPlainTerminal) {
      tabStore.addTerminalTab({ cwd: project.root, shell: project.shell })
    }
  }

  async function flushSession() {
    if (!currentProject.value) return
    currentProject.value.lastSession = useTabStore().snapshotSession()
    await projectUpdate(currentProject.value).catch(() => {})
  }

  function saveSessionDebounced() {
    if (!currentProject.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSession, 1000)
  }

  async function saveSessionNow() {
    if (saveTimer) clearTimeout(saveTimer)
    await flushSession()
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

  function toggleQuickOpen() {
    showQuickOpen.value = !showQuickOpen.value
  }

  return {
    projects,
    currentProject,
    showSwitcher,
    showQuickOpen,
    loadProjects,
    restoreLastProject,
    switchProject,
    saveSessionDebounced,
    saveSessionNow,
    addProject,
    saveProject,
    removeProject,
    toggleSwitcher,
    toggleQuickOpen,
  }
})
