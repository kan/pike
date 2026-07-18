import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { locale } from '../i18n'
import {
  jumplistRefresh,
  openProjectWindow,
  projectAddOpen,
  projectCreate,
  projectDelete,
  projectGetLast,
  projectGroupsList,
  projectGroupsSave,
  projectList,
  projectSetLast,
  projectUpdate,
} from '../lib/tauri'
import { ephemeralWindow } from '../lib/window'
import type { ProjectConfig } from '../types/project'
import { useDiagnosticsStore } from './diagnostics'
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
  const groups = ref<string[]>([])
  const currentProject = ref<ProjectConfig | null>(null)
  const showSwitcher = ref(false)
  const showQuickOpen = ref(false)

  // The git worktree the file tree / git / search / tasks / docker / editor
  // surfaces currently reference. `null` means the project's main root. Reset
  // whenever the project changes; switching worktrees is window-scoped and not
  // persisted.
  const activeWorktreeRoot = ref<string | null>(null)
  // Single source of truth for "which root do root-relative operations use".
  // Always a string (empty only when no project is open), so callers never need
  // their own `?? project.root` fallback — any remaining `project.root` read for
  // a root-relative operation is a bug that forgot to follow the worktree.
  const activeRoot = computed<string>(() => activeWorktreeRoot.value ?? currentProject.value?.root ?? '')

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function loadProjects() {
    projects.value = await projectList()
  }

  // Rebuild the taskbar jump list (issue #160) whenever a jump-list-relevant
  // field changes: the project set, a name/root edit, recency order, or the UI
  // locale (label language). Keyed on exactly those fields so ~1s-debounced
  // session-flush writes — which mutate `lastSession` on objects that also live
  // in `projects` — do NOT trigger a refresh: Vue's per-property tracking never
  // re-runs this getter for `lastSession`. The Rust side additionally dedups by
  // signature, and the jump list is a single per-process OS resource, so
  // refreshing from any window is enough. Best-effort, Windows-only; the list
  // persists from the last run so a failed refresh just goes slightly stale.
  watch(
    () => JSON.stringify([locale.value, projects.value.map((p) => [p.id, p.name, p.root, p.lastOpened])]),
    () => {
      jumplistRefresh(locale.value).catch(() => {})
    },
  )

  async function loadGroups() {
    try {
      const stored = await projectGroupsList()
      const set = new Set(stored)
      let added = false
      for (const p of projects.value) {
        const g = p.group?.trim()
        if (g && !set.has(g)) {
          stored.push(g)
          set.add(g)
          added = true
        }
      }
      groups.value = stored
      if (added) await persistGroups()
    } catch {
      groups.value = []
    }
  }

  async function persistGroups() {
    try {
      await projectGroupsSave(groups.value)
    } catch {
      // best-effort
    }
  }

  async function addGroup(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (groups.value.includes(trimmed)) return
    groups.value = [...groups.value, trimmed]
    await persistGroups()
  }

  async function renameGroup(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    if (groups.value.includes(trimmed)) {
      // merge into existing group
      groups.value = groups.value.filter((g) => g !== oldName)
    } else {
      groups.value = groups.value.map((g) => (g === oldName ? trimmed : g))
    }
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === oldName)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: trimmed })))
  }

  async function removeGroup(name: string) {
    groups.value = groups.value.filter((g) => g !== name)
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === name)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: undefined })))
  }

  async function setProjectGroup(projectId: string, group: string | undefined) {
    const project = projects.value.find((p) => p.id === projectId)
    if (!project) return
    const normalized = group?.trim() ? group.trim() : undefined
    if (project.group === normalized) return
    await saveProject({ ...project, group: normalized })
    if (normalized) await addGroup(normalized)
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
    // Nothing to restore: show the switcher so the user can open/create a
    // project or switch this window into global mode. Shown even with zero
    // projects (first-ever launch) so the global-mode entry is reachable.
    showSwitcher.value = true
  }

  async function switchProject(id: string, opts?: { restoreSession?: boolean }) {
    if (saveTimer) clearTimeout(saveTimer)
    const tabStore = useTabStore()
    const searchStore = useSearchStore()
    const project = projects.value.find((p) => p.id === id)
    if (!project) return
    // Elevated admin project window opens the project context only; the caller
    // adds the single pinned-shell terminal, so skip session/pinned restore.
    const restore = opts?.restoreSession !== false

    searchStore.clear()
    searchStore.backend = null
    useDiagnosticsStore().clear()
    activeWorktreeRoot.value = null

    await tabStore.clearAllTabs()

    project.lastOpened = new Date().toISOString()
    currentProject.value = project

    // Fire-and-forget: don't block tab restoration on metadata persistence
    Promise.all([projectUpdate(project).catch(() => {}), projectAddOpen(id).catch(() => {})])

    if (!restore) return

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
        if (def.kind === 'agent-chat') {
          tabStore.addAgentChatTab({
            pinned: true,
            agentType: (def.agentType as 'codex' | 'claude-code') ?? 'claude-code',
          })
        } else {
          tabStore.addTerminalTab({
            id: def.id,
            title: def.title,
            pinned: true,
            autoStart: def.autoStart,
            cwd: project.root,
            shell: project.shell,
          })
        }
      }
    }

    // Ensure at least one plain terminal tab exists (for CWD detection, etc.)
    const hasPlainTerminal = tabStore.tabs.some((t) => t.kind === 'terminal' && !t.autoStart)
    if (!hasPlainTerminal) {
      tabStore.addTerminalTab({ cwd: project.root, shell: project.shell })
    }
  }

  async function flushSession() {
    // Ephemeral (elevated admin) window: never persist — its lean session would
    // clobber the real one written by the non-elevated instance (#138).
    if (ephemeralWindow.value) return
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

  // Apply a project_updated broadcast from another window: refresh in-memory
  // copies so this window's full-object writes don't revert the edit. The
  // window-local live session is kept (this window owns it while open).
  function applyExternalUpdate(config: ProjectConfig) {
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) projects.value[idx] = config
    if (currentProject.value?.id === config.id) {
      currentProject.value = { ...config, lastSession: currentProject.value.lastSession }
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
    groups,
    currentProject,
    showSwitcher,
    showQuickOpen,
    activeWorktreeRoot,
    activeRoot,
    loadProjects,
    loadGroups,
    addGroup,
    renameGroup,
    removeGroup,
    setProjectGroup,
    restoreLastProject,
    switchProject,
    saveSessionDebounced,
    saveSessionNow,
    addProject,
    saveProject,
    applyExternalUpdate,
    removeProject,
    toggleSwitcher,
    toggleQuickOpen,
  }
})
