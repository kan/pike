<script setup lang="ts">
import { type Component, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useGitStore } from '../../stores/git'
import { useSidebarStore } from '../../stores/sidebar'
import type { SidebarPanel } from '../../types/tab'

const ProjectPanel = defineAsyncComponent(() => import('../panels/ProjectPanel.vue'))
const FileTreePanel = defineAsyncComponent(() => import('../panels/FileTreePanel.vue'))
const GitPanel = defineAsyncComponent(() => import('../panels/GitPanel.vue'))
const DockerPanel = defineAsyncComponent(() => import('../panels/DockerPanel.vue'))
const SearchPanel = defineAsyncComponent(() => import('../panels/SearchPanel.vue'))
const TasksPanel = defineAsyncComponent(() => import('../panels/TasksPanel.vue'))
const OutlinePanel = defineAsyncComponent(() => import('../panels/OutlinePanel.vue'))
const DiagnosticsPanel = defineAsyncComponent(() => import('../panels/DiagnosticsPanel.vue'))
const TodoPanel = defineAsyncComponent(() => import('../panels/TodoPanel.vue'))

import {
  ArrowDown,
  ArrowUp,
  Bot,
  CircleAlert,
  Container,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListTodo,
  ListTree,
  Loader,
  Play,
  RefreshCw,
  Search,
  Settings,
  Square,
} from 'lucide-vue-next'
import { confirmDialog, infoDialog } from '../../composables/useConfirmDialog'
import { useShortcutsModal } from '../../composables/useShortcutsModal'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { openUrlWithConfirm } from '../../lib/tauri'
import { useDiagnosticsStore } from '../../stores/diagnostics'
import { useDockerStore } from '../../stores/docker'
import { useSearchStore } from '../../stores/search'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import { useTodoStore } from '../../stores/todo'
import HelpButton from '../HelpButton.vue'

const { t } = useI18n()
const sidebar = useSidebarStore()
const tabStore = useTabStore()
const gitStore = useGitStore()
const searchStore = useSearchStore()
const diagStore = useDiagnosticsStore()
const dockerStore = useDockerStore()
const todoStore = useTodoStore()
const settingsStore = useSettingsStore()
const shortcutsModal = useShortcutsModal()
const showGearMenu = ref(false)
const showAgentMenu = ref(false)
const updater = useUpdater()

onMounted(() => {
  updater.checkOnceInBackground()
})

function onBotClick() {
  if (settingsStore.agentDefault === 'ask') {
    showAgentMenu.value = !showAgentMenu.value
    if (showAgentMenu.value) {
      nextTick(() => {
        window.addEventListener('mousedown', closeAgentMenu, { once: true })
      })
    }
  } else {
    tabStore.addAgentChatTab({ agentType: settingsStore.agentDefault })
  }
}

function closeAgentMenu() {
  window.removeEventListener('mousedown', closeAgentMenu)
  showAgentMenu.value = false
}

function selectAgent(agentType: 'claude-code' | 'codex') {
  closeAgentMenu()
  tabStore.addAgentChatTab({ agentType })
}

function onGearClick() {
  showGearMenu.value = !showGearMenu.value
  if (showGearMenu.value) {
    nextTick(() => {
      window.addEventListener('mousedown', closeGearMenu, { once: true })
    })
  } else {
    window.removeEventListener('mousedown', closeGearMenu)
  }
}

function closeGearMenu() {
  window.removeEventListener('mousedown', closeGearMenu)
  showGearMenu.value = false
}

function openShortcuts() {
  closeGearMenu()
  shortcutsModal.toggle()
}

function openSettings() {
  closeGearMenu()
  tabStore.addSettingsTab()
}

function openManual() {
  closeGearMenu()
  tabStore.addManualTab()
}

async function openGitHub() {
  closeGearMenu()
  await openUrlWithConfirm('https://github.com/kan/pike')
}

async function checkUpdate() {
  closeGearMenu()
  if (!updater.hasUpdate.value) {
    await updater.checkForUpdate()
  }
  if (updater.hasUpdate.value) {
    if (await confirmDialog(t('settings.updateConfirm', { version: updater.updateVersion.value }))) {
      await updater.downloadAndInstall()
    }
  } else if (updater.state.value === 'upToDate') {
    await infoDialog(t('settings.upToDate'))
  } else {
    await infoDialog(t('settings.updateError'))
  }
}

const fileTreeRef = ref<{
  refresh: () => void
  refreshing: boolean
  startCreateAtRoot: (type: 'file' | 'dir') => void
} | null>(null)
const tasksRef = ref<{ refresh: () => void } | null>(null)

interface BadgeInfo {
  count: number
  danger?: boolean
}
/** Small glyph in the icon's bottom-right corner, with a tooltip suffix. */
interface MarkerInfo {
  text: string
  title: string
}
interface IconDef {
  panel: SidebarPanel
  labelKey: string
  icon: Component
  /** Optional count badge resolver — returns null when nothing to show. */
  badge?: () => BadgeInfo | null
  /** Optional corner marker resolver — returns null when nothing to show. */
  marker?: () => MarkerInfo | null
}

const icons: IconDef[] = [
  { panel: 'files', labelKey: 'sidebar.files', icon: Files },
  { panel: 'outline', labelKey: 'sidebar.outline', icon: ListTree },
  {
    panel: 'git',
    labelKey: 'sidebar.git',
    icon: GitBranch,
    badge: () => {
      const s = gitStore.status
      if (!s) return null
      const n = s.staged.length + s.unstaged.length + s.conflicted.length
      return n > 0 ? { count: n, danger: s.conflicted.length > 0 } : null
    },
    // Unpushed / unpulled commits. The count badge is taken by the working-tree
    // change count, so this rides along as an arrow in the opposite corner.
    marker: () => {
      const s = gitStore.status
      if (!s || (!s.ahead && !s.behind)) return null
      const parts: string[] = []
      if (s.ahead) parts.push(t('git.aheadInfo', { count: s.ahead }))
      if (s.behind) parts.push(t('git.behindInfo', { count: s.behind }))
      return { text: `${s.ahead ? '↑' : ''}${s.behind ? '↓' : ''}`, title: parts.join(' · ') }
    },
  },
  { panel: 'search', labelKey: 'sidebar.search', icon: Search },
  {
    panel: 'diagnostics',
    labelKey: 'sidebar.diagnostics',
    icon: CircleAlert,
    badge: () => (diagStore.total > 0 ? { count: diagStore.total, danger: diagStore.errorCount > 0 } : null),
  },
  { panel: 'docker', labelKey: 'sidebar.docker', icon: Container },
  { panel: 'projects', labelKey: 'sidebar.projects', icon: FolderOpen },
  { panel: 'tasks', labelKey: 'sidebar.tasks', icon: Play },
  {
    panel: 'todo',
    labelKey: 'sidebar.todo',
    icon: ListTodo,
    badge: () => (todoStore.progress.remaining > 0 ? { count: todoStore.progress.remaining } : null),
  },
]

/** panel → manual-relative help target (`page#anchor`). Panels without a manual
 *  section (todo, etc.) are omitted and show no `?` button. */
const PANEL_HELP: Partial<Record<SidebarPanel, string>> = {
  files: 'panels.md#ファイルツリー',
  git: 'git.md',
  search: 'panels.md#検索ripgrep--grep',
  docker: 'panels.md#docker',
  projects: 'projects-and-windows.md',
  tasks: 'panels.md#タスク',
  todo: 'panels.md#todoやること',
  outline: 'panels.md#アウトライン',
  diagnostics: 'panels.md#problems診断',
}
const panelHelp = computed(() => (sidebar.activePanel ? PANEL_HELP[sidebar.activePanel] : undefined))

/** panel → current badge/marker, recomputed once per reactive change (not per render). */
const badges = computed(() => {
  const map: Partial<Record<SidebarPanel, BadgeInfo | null>> = {}
  for (const item of icons) {
    if (item.badge) map[item.panel] = item.badge()
  }
  return map
})
const markers = computed(() => {
  const map: Partial<Record<SidebarPanel, MarkerInfo | null>> = {}
  for (const item of icons) {
    if (item.marker) map[item.panel] = item.marker()
  }
  return map
})

function iconTitle(item: IconDef) {
  const base = t(item.labelKey)
  const marker = markers.value[item.panel]
  return marker ? `${base} (${marker.title})` : base
}

let dragging = false
let startX = 0
let startWidth = 0

function onResizeStart(e: MouseEvent) {
  dragging = true
  startX = e.clientX
  startWidth = sidebar.panelWidth
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResizeMove(e: MouseEvent) {
  if (!dragging) return
  // The sidebar carries the UI zoom, so a viewport-px mouse delta corresponds to
  // delta / zoom logical px on the (zoomed) panel width.
  sidebar.setPanelWidth(startWidth + (e.clientX - startX) / settingsStore.uiZoom)
}

function onResizeEnd() {
  dragging = false
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  window.removeEventListener('mousedown', closeGearMenu)
  window.removeEventListener('mousedown', closeAgentMenu)
})
</script>

<template>
  <div class="sidebar ui-zoom">
    <nav class="icon-strip">
      <button
        v-for="item in icons"
        :key="item.panel"
        class="icon-button"
        :class="{ active: sidebar.activePanel === item.panel }"
        :title="iconTitle(item)"
        @click="sidebar.togglePanel(item.panel)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" class="icon" />
        <span
          v-if="badges[item.panel]"
          class="count-badge"
          :class="{ danger: badges[item.panel]?.danger }"
        >{{ badges[item.panel]?.count }}</span>
        <span v-if="markers[item.panel]" class="marker-badge">{{ markers[item.panel]?.text }}</span>
      </button>
      <div class="icon-spacer" />
      <div class="bot-wrapper">
        <div v-if="showAgentMenu" class="agent-menu popup-surface" @mousedown.stop>
          <button class="agent-menu-item" @click="selectAgent('claude-code')">Claude Code</button>
          <button class="agent-menu-item" @click="selectAgent('codex')">Codex</button>
        </div>
        <button
          class="icon-button"
          :title="t('sidebar.agent')"
          @click="onBotClick"
        >
          <Bot :size="22" :stroke-width="1.5" class="icon" />
        </button>
      </div>
      <div class="gear-wrapper">
        <div v-if="showGearMenu" class="gear-menu popup-surface" @mousedown.stop>
          <button class="gear-menu-item" @click="checkUpdate">
            <span>{{ t('settings.checkUpdate') }}</span>
            <span v-if="updater.hasUpdate.value" class="update-badge">NEW</span>
          </button>
          <div class="gear-menu-divider" />
          <button class="gear-menu-item" @click="openShortcuts">
            <span>{{ t('sidebar.keyboardShortcuts') }}</span>
            <span class="ctx-key">Ctrl+K</span>
          </button>
          <button class="gear-menu-item" @click="openSettings">
            <span>{{ t('sidebar.settings') }}</span>
            <span class="ctx-key">Ctrl+,</span>
          </button>
          <div class="gear-menu-divider" />
          <button class="gear-menu-item" @click="openManual">
            <span>{{ t('sidebar.manual') }}</span>
            <span class="ctx-key">F1</span>
          </button>
          <button class="gear-menu-item" @click="openGitHub">
            <span>{{ t('sidebar.github') }}</span>
          </button>
        </div>
        <button
          class="icon-button"
          :title="t('sidebar.settings')"
          @click="onGearClick"
        >
          <Settings :size="22" :stroke-width="1.5" class="icon" />
          <span v-if="updater.hasUpdate.value" class="update-dot" />
        </button>
      </div>
    </nav>
    <aside v-if="sidebar.isPanelOpen" class="panel" :style="{ width: sidebar.panelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">{{ t(icons.find((i) => i.panel === sidebar.activePanel)?.labelKey ?? '') }}</span>
        <div v-if="sidebar.activePanel === 'files'" class="header-actions">
          <button class="header-btn" :title="t('fileTree.newFile')" @click="fileTreeRef?.startCreateAtRoot('file')">
            <FilePlus :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :title="t('fileTree.newFolder')" @click="fileTreeRef?.startCreateAtRoot('dir')">
            <FolderPlus :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :title="t('common.refresh')" @click="fileTreeRef?.refresh()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: fileTreeRef?.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'search'" class="header-actions">
          <span class="backend-badge">{{ searchStore.backend ?? '...' }}</span>
        </div>
        <div v-if="sidebar.activePanel === 'git'" class="header-actions">
          <button class="header-btn" :class="{ primary: gitStore.status?.behind }" :disabled="gitStore.pulling" :title="t('git.pull')" @click="gitStore.pull()">
            <Loader v-if="gitStore.pulling" :size="14" :stroke-width="2" class="spin" />
            <ArrowDown v-else :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :class="{ primary: gitStore.status?.ahead }" :disabled="gitStore.pushing" :title="t('git.push')" @click="gitStore.push()">
            <Loader v-if="gitStore.pushing" :size="14" :stroke-width="2" class="spin" />
            <ArrowUp v-else :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :disabled="gitStore.refreshing" :title="t('common.refresh')" @click="gitStore.refreshStatus(true); gitStore.refreshLog()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: gitStore.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'docker'" class="header-actions">
          <template v-if="dockerStore.connected && dockerStore.composeServices.length">
            <button class="header-btn" :title="t('docker.composeUp')" @click="dockerStore.composeUp()">
              <Play :size="14" :stroke-width="2" />
            </button>
            <button class="header-btn" :title="t('docker.composeDown')" @click="dockerStore.composeDown()">
              <Square :size="14" :stroke-width="2" />
            </button>
          </template>
          <button class="header-btn" :disabled="dockerStore.refreshing" :title="t('common.refresh')" @click="dockerStore.refreshContainers(true)">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: dockerStore.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'tasks'" class="header-actions">
          <button class="header-btn" :title="t('common.refresh')" @click="tasksRef?.refresh()">
            <RefreshCw :size="14" :stroke-width="2" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'diagnostics'" class="header-actions">
          <button class="header-btn" :disabled="diagStore.running" :title="t('common.refresh')" @click="diagStore.run()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: diagStore.running }" />
          </button>
        </div>
        <HelpButton v-if="panelHelp" :page="panelHelp" :size="15" class="panel-help" />
      </div>
      <div class="panel-content">
        <ProjectPanel v-if="sidebar.activePanel === 'projects'" />
        <FileTreePanel v-else-if="sidebar.activePanel === 'files'" ref="fileTreeRef" />
        <GitPanel v-else-if="sidebar.activePanel === 'git'" />
        <SearchPanel v-else-if="sidebar.activePanel === 'search'" />
        <DockerPanel v-else-if="sidebar.activePanel === 'docker'" />
        <TasksPanel v-else-if="sidebar.activePanel === 'tasks'" ref="tasksRef" />
        <TodoPanel v-else-if="sidebar.activePanel === 'todo'" />
        <OutlinePanel v-else-if="sidebar.activePanel === 'outline'" />
        <DiagnosticsPanel v-else-if="sidebar.activePanel === 'diagnostics'" />
        <span v-else class="placeholder">{{ sidebar.activePanel }} panel (coming soon)</span>
      </div>
      <div class="resize-handle" @mousedown="onResizeStart"></div>
    </aside>
  </div>
</template>

<style scoped>
.sidebar {
  display: flex;
  height: 100%;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
}

.icon-strip {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  padding-top: 4px;
  padding-bottom: 4px;
  /* Window transparency (issue #162): the parent .sidebar already paints
     --bg-secondary, so painting it again here stacked a second translucent layer
     and made the icon bar look heavier than the panels. Inherit the sidebar
     background instead of doubling it. */
  background: transparent;
}

.icon-spacer {
  flex: 1;
}

.bot-wrapper {
  position: relative;
}

.agent-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  white-space: nowrap;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 1000;
}

.agent-menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.agent-menu-item:hover {
  background: var(--accent);
  color: var(--text-active);
}

.gear-wrapper {
  position: relative;
}

.gear-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  white-space: nowrap;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 1000;
}

.gear-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.gear-menu-item:hover {
  background: var(--accent);
  color: var(--text-active);
}

.gear-menu-item:hover .ctx-key {
  color: rgba(255, 255, 255, 0.7);
}

.gear-menu-item .ctx-key {
  margin-left: 16px;
}

.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--sidebar-width);
  height: var(--sidebar-width);
  border: none;
  background: transparent;
  cursor: pointer;
  position: relative;
  opacity: 0.6;
  transition: opacity 0.15s;
}

.icon-button:hover {
  opacity: 1;
}

.icon-button.active {
  opacity: 1;
}

.icon-button.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 25%;
  height: 50%;
  width: 2px;
  background: var(--accent);
}

.icon {
  color: var(--text-secondary);
}

.icon-button.active .icon {
  color: var(--text-active);
}

.panel {
  position: relative;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.panel-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-help {
  margin-left: 2px;
}

.header-actions {
  display: flex;
  gap: 2px;
}

.header-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
  color: var(--text-active);
}

.header-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.header-btn .spin {
  animation: spin 1s linear infinite;
}

.header-btn.primary {
  background: var(--accent);
  color: var(--text-active);
  opacity: 1;
}

.header-btn.primary:hover:not(:disabled) {
  background: var(--accent);
  opacity: 0.85;
}

.backend-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  text-transform: lowercase;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.resize-handle {
  position: absolute;
  right: -3px;
  top: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}

.resize-handle:hover {
  background: var(--accent);
  opacity: 0.3;
}

.placeholder {
  color: var(--text-secondary);
  font-size: 12px;
}

.update-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f44336;
  pointer-events: none;
}

.count-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--text-secondary);
  color: var(--bg-secondary);
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  pointer-events: none;
}

.marker-badge {
  position: absolute;
  bottom: 3px;
  right: 5px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -1px;
  color: var(--accent);
  pointer-events: none;
}

.count-badge.danger {
  background: #f44336;
  color: #fff;
}

.gear-menu-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.update-badge {
  font-size: 9px;
  font-weight: 700;
  background: #f44336;
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 8px;
}
</style>
