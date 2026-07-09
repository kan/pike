<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { computed, onMounted, watch } from 'vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import KeyboardShortcuts from './components/KeyboardShortcuts.vue'
import SideBar from './components/layout/SideBar.vue'
import StatusBar from './components/layout/StatusBar.vue'
import TabPane from './components/layout/TabPane.vue'
import ProjectSwitcher from './components/ProjectSwitcher.vue'
import QuickOpen from './components/QuickOpen.vue'
import { initAgentRouter } from './composables/useAgentRouter'
import { initCliOpen, peekInitialCliAction } from './composables/useCliOpen'
import { dockerLogRouter } from './composables/useDockerLogRouter'
import { type FsChangeEntry, fsWatcher, isRecentlySaved } from './composables/useFsWatcher'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { ptyRouter } from './composables/usePtyRouter'
import { initTerminalNotifications } from './composables/useTerminalNotifications'
import { useI18n } from './i18n'
import { clearAliasCache } from './lib/jumpTo/resolveImport'
import { clearGlobalComponentsCache } from './lib/jumpTo/vueComponent'
import { normalizeSep } from './lib/paths'
import { projectColorValue } from './lib/projectColors'
import { isElevated, projectRemoveOpen } from './lib/tauri'
import { elevated, ephemeralWindow, getWindowProjectId, globalMode, isGlobalWindow, isMainWindow } from './lib/window'
import { useClaudeRateStore } from './stores/claudeRate'
import { useClaudeUsageStore } from './stores/claudeUsage'
import { useCodexUsageStore } from './stores/codexUsage'
import { useDiagnosticsStore } from './stores/diagnostics'
import { useGitStore } from './stores/git'
import { useProjectStore } from './stores/project'
import { useTabStore } from './stores/tabs'
import { useWorktreeStore } from './stores/worktree'
import type { ProjectConfig } from './types/project'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const gitStore = useGitStore()
const worktreeStore = useWorktreeStore()
const claudeUsageStore = useClaudeUsageStore()
const claudeRateStore = useClaudeRateStore()
const codexUsageStore = useCodexUsageStore()
const diagStore = useDiagnosticsStore()

useKeyboardShortcuts()

const isDebug = import.meta.env.DEV

// Window-wide project accent line: tells coexisting windows apart at a glance
const projectAccent = computed(() => projectColorValue(projectStore.currentProject?.color))

watch(
  [() => projectStore.currentProject?.name, elevated],
  ([name, isAdmin]) => {
    let base = name ? t('app.titleWithProject', { name }) : t('app.title')
    if (isAdmin) base = `${t('app.adminTitlePrefix')} ${base}`
    const title = isDebug ? `[DEBUG] ${base}` : base
    getCurrentWindow().setTitle(title)
  },
  { immediate: true },
)

// Centralized git polling lifecycle
watch(
  () => projectStore.currentProject?.id,
  (id) => {
    if (id) {
      gitStore.startPolling()
      worktreeStore.startPolling()
      claudeUsageStore.startPolling()
      claudeRateStore.startPolling()
      codexUsageStore.startPolling()
    } else {
      gitStore.stopPolling()
      worktreeStore.stopPolling()
      worktreeStore.reset()
      claudeUsageStore.stopPolling()
      claudeRateStore.stopPolling()
      codexUsageStore.stopPolling()
    }
  },
)

// File watcher lifecycle — keyed on the active root so it follows worktree
// switches (not just project switches) from a single owner.
watch(
  () => projectStore.activeRoot,
  async (root) => {
    // Drop jumpTo caches when the root changes so resolved paths don't bleed
    // across projects or worktrees (which may have different config).
    clearAliasCache()
    clearGlobalComponentsCache()
    const project = projectStore.currentProject
    if (project && root) {
      await fsWatcher.start(project.shell, root)
    } else {
      await fsWatcher.stop()
    }
  },
)

const ALIAS_CONFIG_NAMES = /[\\/](?:tsconfig|jsconfig)\.json$|[\\/]vite\.config\.(?:[mc]?js|ts)$/
const MAIN_FILE_NAMES = /[\\/]main\.(?:[mc]?js|ts)$/

fsWatcher.onFileChange((files: FsChangeEntry[]) => {
  let aliasInvalidated = false
  let globalsInvalidated = false
  for (const change of files) {
    if (!aliasInvalidated && ALIAS_CONFIG_NAMES.test(change.path)) {
      clearAliasCache()
      aliasInvalidated = true
    }
    if (!globalsInvalidated && MAIN_FILE_NAMES.test(change.path)) {
      clearGlobalComponentsCache()
      globalsInvalidated = true
    }
    if (isRecentlySaved(change.path)) continue
    // Separator-insensitive compare: tab paths can mix `/` and `\` on Windows
    // (git emits `/`), while the native watcher always emits `\`.
    const changedPath = normalizeSep(change.path)
    for (const tab of tabStore.tabs) {
      if (tab.kind === 'editor' && tab.path && normalizeSep(tab.path) === changedPath) {
        tab.externalChange = change.kind === 'delete' ? 'deleted' : 'modified'
      }
    }
  }
  // Re-check diagnostics on source changes (throttled; no-op until the user has
  // opened the Problems panel at least once).
  diagStore.triggerAutoRun()
})

const windowProjectId = getWindowProjectId()

// Global-mode windows exist only for their tabs: closing the last one closes
// the window (Windows Terminal-like lifecycle). --wait windows usually close
// via the wait signal first; this also covers plain file/terminal windows.
watch(
  () => tabStore.tabs.length,
  (len, prev) => {
    if (globalMode.value && prev > 0 && len === 0) {
      getCurrentWindow().close()
    }
  },
)

onMounted(async () => {
  // Elevation is static per process; resolve once so the shield indicator and
  // window title reflect an admin instance (#138).
  isElevated()
    .then((v) => {
      elevated.value = v
    })
    .catch(() => {})

  await Promise.all([ptyRouter.init(), dockerLogRouter.init(), fsWatcher.init(), initAgentRouter()])

  if (windowProjectId) {
    await projectStore.loadProjects()
    await projectStore.switchProject(windowProjectId)
  } else if (isGlobalWindow()) {
    // Global window: no project context; initCliOpen opens the requested tabs.
  } else {
    // Cold start with real-file args ("Open with", drag onto pike.exe,
    // `pike file.rs`): open a lean global-mode editor instead of restoring
    // projects. last_project.txt stays untouched for the next plain launch.
    const initial = await peekInitialCliAction()
    if (initial.action === 'openFiles' || initial.action === 'openTerminal') {
      globalMode.value = true
    } else if (initial.action === 'openProject') {
      // Elevated admin relaunch from a project window (#138): open the project
      // in normal mode (initCliOpen switches + adds the terminal). Mark the
      // window ephemeral so it never persists its lean session over the real one.
      ephemeralWindow.value = true
    } else {
      await projectStore.restoreLastProject()
    }
  }

  await initCliOpen()
  initTerminalNotifications().catch(() => {})

  // Broadcast + self-filter (PTY/Docker と同方式): keep every window's
  // in-memory project copies fresh so stale full-object writes (flushSession /
  // switchProject) can't clobber edits made in another window.
  const ownLabel = getCurrentWindow().label
  listen<{ sourceLabel: string; config: ProjectConfig }>('project_updated', (event) => {
    if (event.payload.sourceLabel === ownLabel) return
    projectStore.applyExternalUpdate(event.payload.config)
  })

  tabStore.$subscribe(() => projectStore.saveSessionDebounced())
  window.addEventListener('beforeunload', () => {
    projectStore.saveSessionNow()
    if (projectStore.currentProject) {
      projectRemoveOpen(projectStore.currentProject.id)
    }
  })

  // Main window: save session + stop background work when hiding,
  // and destroy self when all project windows have closed.
  if (isMainWindow()) {
    listen('window-hide-requested', async () => {
      await projectStore.saveSessionNow()
      gitStore.stopPolling()
      claudeUsageStore.stopPolling()
      claudeRateStore.stopPolling()
      codexUsageStore.stopPolling()
      await fsWatcher.stop()
    })
    listen('app-should-exit', () => {
      getCurrentWindow().destroy()
    })
  }
})
</script>

<template>
  <div class="app">
    <div v-if="projectAccent" class="project-accent" :style="{ background: projectAccent }"></div>
    <div class="app-main">
      <SideBar v-if="!globalMode" />
      <TabPane />
    </div>
    <StatusBar />
    <!-- Global mode keeps the switcher: Ctrl+Shift+P opens the picked project
         in its own window (this window stays project-less). -->
    <ProjectSwitcher />
    <QuickOpen v-if="!globalMode" />
    <ConfirmDialog />
    <KeyboardShortcuts />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.project-accent {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  z-index: 100;
  pointer-events: none;
}
</style>
