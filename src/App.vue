<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted, watch } from 'vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import KeyboardShortcuts from './components/KeyboardShortcuts.vue'
import SideBar from './components/layout/SideBar.vue'
import StatusBar from './components/layout/StatusBar.vue'
import TabPane from './components/layout/TabPane.vue'
import ProjectSwitcher from './components/ProjectSwitcher.vue'
import QuickOpen from './components/QuickOpen.vue'
import { initAgentRouter } from './composables/useAgentRouter'
import { hasPendingCliAction, initCliOpen } from './composables/useCliOpen'
import { initCodexRouter } from './composables/useCodexRouter'
import { dockerLogRouter } from './composables/useDockerLogRouter'
import { type FsChangeEntry, fsWatcher, isRecentlySaved } from './composables/useFsWatcher'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { ptyRouter } from './composables/usePtyRouter'
import { initTerminalNotifications } from './composables/useTerminalNotifications'
import { useI18n } from './i18n'
import { projectRemoveOpen } from './lib/tauri'
import { getWindowProjectId, isMainWindow, isSecondaryWindow } from './lib/window'
import { useClaudeUsageStore } from './stores/claudeUsage'
import { useGitStore } from './stores/git'
import { useProjectStore } from './stores/project'
import { useTabStore } from './stores/tabs'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const gitStore = useGitStore()
const claudeUsageStore = useClaudeUsageStore()

useKeyboardShortcuts()

const isDebug = import.meta.env.DEV

watch(
  () => projectStore.currentProject?.name,
  (name) => {
    const base = name ? t('app.titleWithProject', { name }) : t('app.title')
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
      claudeUsageStore.startPolling()
    } else {
      gitStore.stopPolling()
      claudeUsageStore.stopPolling()
    }
  },
)

// File watcher lifecycle
watch(
  () => projectStore.currentProject?.id,
  async () => {
    const project = projectStore.currentProject
    if (project) {
      await fsWatcher.start(project.shell, project.root)
    } else {
      await fsWatcher.stop()
    }
  },
)

fsWatcher.onFileChange((files: FsChangeEntry[]) => {
  for (const change of files) {
    if (isRecentlySaved(change.path)) continue
    for (const tab of tabStore.tabs) {
      if (tab.kind === 'editor' && tab.path === change.path) {
        tab.externalChange = change.kind === 'delete' ? 'deleted' : 'modified'
      }
    }
  }
})

const windowProjectId = getWindowProjectId()

onMounted(async () => {
  await Promise.all([ptyRouter.init(), dockerLogRouter.init(), fsWatcher.init(), initCodexRouter(), initAgentRouter()])

  if (windowProjectId) {
    await projectStore.loadProjects()
    await projectStore.switchProject(windowProjectId)
  } else if (isSecondaryWindow() && (await hasPendingCliAction())) {
    // Secondary window with a CLI action: skip project restore.
    // initCliOpen will open the requested tab without a project context.
  } else {
    await projectStore.restoreLastProject()
  }

  await initCliOpen()
  initTerminalNotifications().catch(() => {})

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
    <div class="app-main">
      <SideBar />
      <TabPane />
    </div>
    <StatusBar />
    <ProjectSwitcher />
    <QuickOpen />
    <ConfirmDialog />
    <KeyboardShortcuts />
  </div>
</template>

<style scoped>
.app {
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
</style>
