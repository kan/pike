<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onUnmounted, ref } from 'vue'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { ShellType, Tab } from '../../types/tab'
import { isWindowsShell, shellToType, WINDOWS_SHELLS } from '../../types/tab'
import TerminalTab from '../tabs/TerminalTab.vue'

const DiffTab = defineAsyncComponent(() => import('../tabs/DiffTab.vue'))
const EditorTab = defineAsyncComponent(() => import('../tabs/EditorTab.vue'))
const PreviewTab = defineAsyncComponent(() => import('../tabs/PreviewTab.vue'))
const HistoryTab = defineAsyncComponent(() => import('../tabs/HistoryTab.vue'))
const DockerLogsTab = defineAsyncComponent(() => import('../tabs/DockerLogsTab.vue'))
const SettingsTab = defineAsyncComponent(() => import('../tabs/SettingsTab.vue'))
const PdfTab = defineAsyncComponent(() => import('../tabs/PdfTab.vue'))
const CodexChatTab = defineAsyncComponent(() => import('../tabs/CodexChatTab.vue'))

import { Bot, ChevronDown, Pin, Plus, ScrollText, Settings, Terminal, X } from 'lucide-vue-next'
import { useI18n } from '../../i18n'
import { fileIconSvg } from '../../lib/fileIcons'

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const terminalTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'terminal'))

const diffTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'diff'))

const editorTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'editor'))

const previewTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'preview'))

const historyTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'history'))

const dockerLogsTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'docker-logs'))

const settingsTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'settings'))

const pdfTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'pdf'))

const codexChatTabs = computed(() => tabStore.tabs.filter((t) => t.kind === 'codex-chat'))

const isWindows = computed(() =>
  projectStore.currentProject ? isWindowsShell(projectStore.currentProject.shell) : false,
)

function tabFileIconSvg(tab: Tab): string | null {
  if (tab.kind === 'editor') return fileIconSvg(tab.path)
  if (tab.kind === 'preview') return fileIconSvg(tab.path)
  if (tab.kind === 'diff') return fileIconSvg(tab.filePath)
  if (tab.kind === 'history') return fileIconSvg(tab.filePath)
  if (tab.kind === 'pdf') return fileIconSvg(tab.path)
  return null
}

function addTab(shellOverride?: ShellType) {
  const project = projectStore.currentProject
  tabStore.addTerminalTab(project ? { cwd: project.root, shell: shellOverride ?? project.shell } : undefined)
}

// Shell dropdown for Windows projects
const showShellMenu = ref(false)

function toggleShellMenu() {
  if (showShellMenu.value) {
    closeShellMenu()
    return
  }
  showShellMenu.value = true
  nextTick(() => {
    window.addEventListener('mousedown', closeShellMenu, { once: true })
  })
}

function closeShellMenu() {
  window.removeEventListener('mousedown', closeShellMenu)
  showShellMenu.value = false
}

function addTabWithShell(kind: 'cmd' | 'powershell' | 'git-bash') {
  addTab(shellToType(kind))
  closeShellMenu()
}

// Drag-and-drop reordering
const dragTabId = ref<string | null>(null)
const dragOverTabId = ref<string | null>(null)
const dragSide = ref<'left' | 'right'>('left')

function onDragStart(e: DragEvent, tabId: string) {
  dragTabId.value = tabId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)
  }
}

function onDragOver(e: DragEvent, tabId: string) {
  if (!dragTabId.value || dragTabId.value === tabId) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const midX = rect.left + rect.width / 2
  dragSide.value = e.clientX < midX ? 'left' : 'right'
  dragOverTabId.value = tabId
}

function onDragLeave() {
  dragOverTabId.value = null
}

function onDrop(e: DragEvent, tabId: string) {
  e.preventDefault()
  if (!dragTabId.value || dragTabId.value === tabId) {
    resetDrag()
    return
  }

  const fromIdx = tabStore.tabs.findIndex((t) => t.id === dragTabId.value)
  let toIdx = tabStore.tabs.findIndex((t) => t.id === tabId)
  if (fromIdx === -1 || toIdx === -1) {
    resetDrag()
    return
  }

  if (dragSide.value === 'right') toIdx++
  if (fromIdx < toIdx) toIdx--

  tabStore.moveTab(fromIdx, toIdx)
  resetDrag()
}

function onDragEnd() {
  resetDrag()
}

function resetDrag() {
  dragTabId.value = null
  dragOverTabId.value = null
}

// Context menu (tabId is null for tab-bar empty area)
const contextMenu = ref<{ x: number; y: number; tabId: string | null } | null>(null)
const contextTab = computed(() =>
  contextMenu.value?.tabId ? (tabStore.tabs.find((t) => t.id === contextMenu.value!.tabId) ?? null) : null,
)

const contextTabPath = computed(() => {
  const tab = contextTab.value
  if (!tab) return null
  switch (tab.kind) {
    case 'editor':
    case 'preview':
    case 'pdf':
      return tab.path
    case 'diff':
    case 'history':
      return tab.filePath
    default:
      return null
  }
})

function onTabContextMenu(e: MouseEvent, tabId: string | null) {
  e.preventDefault()
  window.removeEventListener('mousedown', closeContextMenu)
  contextMenu.value = { x: e.clientX, y: e.clientY, tabId }
  nextTick(() => {
    window.addEventListener('mousedown', closeContextMenu, { once: true })
  })
}

function onTabBarDblClick(e: MouseEvent) {
  // Only trigger on the empty area (not on a tab or button)
  const target = e.target as HTMLElement
  if (target.closest('.tab') || target.closest('.tab-add-group')) return
  tabStore.addBlankEditorTab()
}

function closeContextMenu() {
  contextMenu.value = null
}

async function copyPath() {
  if (!contextTabPath.value) return
  await navigator.clipboard.writeText(contextTabPath.value)
  closeContextMenu()
}

function openGitHistory() {
  if (!contextTab.value || contextTab.value.kind !== 'editor') return
  tabStore.addHistoryTab({ filePath: contextTab.value.path })
  closeContextMenu()
}

onUnmounted(() => {
  window.removeEventListener('mousedown', closeShellMenu)
  window.removeEventListener('mousedown', closeContextMenu)
})
</script>

<template>
  <div class="tab-pane">
    <!-- Tab Bar -->
    <div class="tab-bar" @dblclick="onTabBarDblClick" @contextmenu="onTabContextMenu($event, null)">
      <div class="tabs-scroll">
        <div
          v-for="tab in tabStore.tabs"
          :key="tab.id"
          class="tab"
          :class="{
            active: tab.id === tabStore.activeTabId,
            dragging: tab.id === dragTabId,
            'drag-over-left': tab.id === dragOverTabId && dragSide === 'left',
            'drag-over-right': tab.id === dragOverTabId && dragSide === 'right',
          }"
          draggable="true"
          @click="tabStore.setActiveTab(tab.id)"
          @mousedown.middle.prevent="tabStore.closeTab(tab.id)"
          @contextmenu.stop="onTabContextMenu($event, tab.id)"
          @dragstart="onDragStart($event, tab.id)"
          @dragover="onDragOver($event, tab.id)"
          @dragleave="onDragLeave"
          @drop="onDrop($event, tab.id)"
          @dragend="onDragEnd"
        >
          <Pin v-if="tab.pinned" :size="12" :stroke-width="2" class="tab-pin" :title="t('tabs.pinned')" />
          <span v-if="tabFileIconSvg(tab)" class="tab-icon tab-icon-svg" v-html="tabFileIconSvg(tab)" />
          <Terminal v-else-if="tab.kind === 'terminal'" :size="14" :stroke-width="1.5" class="tab-icon" />
          <ScrollText v-else-if="tab.kind === 'docker-logs'" :size="14" :stroke-width="1.5" class="tab-icon" />
          <Settings v-else-if="tab.kind === 'settings'" :size="14" :stroke-width="1.5" class="tab-icon" />
          <Bot v-else-if="tab.kind === 'codex-chat'" :size="14" :stroke-width="1.5" class="tab-icon" />
          <span class="tab-title">{{ tab.title }}</span>
          <span
            v-if="tab.kind === 'terminal' && tab.exitCode != null"
            class="tab-exit-badge"
            :class="{ 'exit-ok': tab.exitCode === 0 }"
            :title="'Exit code: ' + tab.exitCode"
          >{{ tab.exitCode === 0 ? '✓' : tab.exitCode }}</span>
          <span
            v-else-if="(tab.kind === 'terminal' || tab.kind === 'codex-chat') && tab.hasActivity && tab.id !== tabStore.activeTabId"
            class="tab-activity-dot"
          />
          <button
            v-if="!tab.pinned"
            class="tab-close"
            :title="t('tabs.close')"
            @click.stop="tabStore.closeTab(tab.id)"
          >
            <X :size="14" :stroke-width="2" />
          </button>
        </div>
      </div>
      <div class="tab-add-group">
        <button class="tab-add" :title="t('tabs.newTerminal')" @click="addTab()"><Plus :size="16" :stroke-width="2" /></button>
        <button
          v-if="isWindows"
          class="tab-add-arrow"
          :title="t('tabs.openWithShell')"
          @click.stop="toggleShellMenu"
        ><ChevronDown :size="12" :stroke-width="2" /></button>
      </div>
      <!-- Shell dropdown -->
      <div v-if="showShellMenu" class="shell-menu" @mousedown.stop>
        <button
          v-for="s in WINDOWS_SHELLS"
          :key="s.kind"
          @click="addTabWithShell(s.kind)"
        >{{ s.label }}</button>
      </div>
    </div>

    <!-- Tab Content -->
    <div class="tab-content">
      <TerminalTab
        v-for="tab in terminalTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <DiffTab
        v-for="tab in diffTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <EditorTab
        v-for="tab in editorTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <PreviewTab
        v-for="tab in previewTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <HistoryTab
        v-for="tab in historyTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <DockerLogsTab
        v-for="tab in dockerLogsTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <SettingsTab
        v-for="tab in settingsTabs"
        :key="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <PdfTab
        v-for="tab in pdfTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />
      <CodexChatTab
        v-for="tab in codexChatTabs"
        :key="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />

      <!-- Empty state -->
      <div v-if="tabStore.tabs.length === 0" class="empty-state">
        <template v-if="projectStore.currentProject">
          {{ t('app.emptyTerminal') }}
        </template>
        <template v-else>
          {{ t('app.emptyProject') }}
        </template>
      </div>
    </div>

    <!-- Context Menu (on a tab) -->
    <div
      v-if="contextMenu && contextTab"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @mousedown.stop
    >
      <button @click="tabStore.togglePin(contextMenu!.tabId!); closeContextMenu()">
        {{ contextTab.pinned ? t('tabs.unpin') : t('tabs.pin') }}
      </button>
      <button
        v-if="!contextTab.pinned"
        @click="tabStore.closeTab(contextMenu!.tabId!); closeContextMenu()"
      >
        <span>{{ t('tabs.closeTab') }}</span><span class="ctx-key">Ctrl+W</span>
      </button>
      <div class="context-menu-separator" />
      <button @click="tabStore.closeOtherTabs(contextMenu!.tabId!); closeContextMenu()">
        {{ t('tabs.closeOthers') }}
      </button>
      <button @click="tabStore.closeTabsToRight(contextMenu!.tabId!); closeContextMenu()">
        {{ t('tabs.closeToRight') }}
      </button>
      <button @click="tabStore.closeSavedTabs(); closeContextMenu()">
        {{ t('tabs.closeSaved') }}
      </button>
      <button @click="tabStore.closeAllTabs(); closeContextMenu()">
        {{ t('tabs.closeAll') }}
      </button>
      <template v-if="contextTabPath">
        <div class="context-menu-separator" />
        <button @click="copyPath()">
          {{ t('tabs.copyPath') }}
        </button>
        <button
          v-if="contextTab.kind === 'editor'"
          @click="openGitHistory()"
        >
          <span>{{ t('tabs.gitHistory') }}</span><span class="ctx-key">Alt+H</span>
        </button>
      </template>
    </div>
    <!-- Context Menu (on tab bar empty area) -->
    <div
      v-else-if="contextMenu && !contextMenu.tabId"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @mousedown.stop
    >
      <button @click="tabStore.addBlankEditorTab(); closeContextMenu()">
        <span>{{ t('tabs.newEditor') }}</span><span class="ctx-key">Ctrl+N</span>
      </button>
      <button @click="addTab(); closeContextMenu()">
        <span>{{ t('tabs.newTerminalShort') }}</span><span class="ctx-key">Ctrl+T</span>
      </button>
      <template v-if="tabStore.tabs.length > 0">
        <div class="context-menu-separator" />
        <button @click="tabStore.closeSavedTabs(); closeContextMenu()">
          {{ t('tabs.closeSaved') }}
        </button>
        <button @click="tabStore.closeAllTabs(); closeContextMenu()">
          {{ t('tabs.closeAll') }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tab-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-height);
  min-height: var(--tabbar-height);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  user-select: none;
  position: relative;
}

.tabs-scroll {
  display: flex;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}

.tabs-scroll::-webkit-scrollbar {
  height: 0;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  min-width: 80px;
  max-width: 180px;
  height: 100%;
  background: var(--tab-inactive-bg);
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.1s;
  white-space: nowrap;
}

.tab:hover {
  background: var(--tab-hover-bg);
}

.tab.dragging {
  opacity: 0.4;
}

.tab.drag-over-left {
  box-shadow: inset 2px 0 0 0 var(--accent);
}

.tab.drag-over-right {
  box-shadow: inset -2px 0 0 0 var(--accent);
}

.tab.active {
  background: var(--tab-active-bg);
  color: var(--text-active);
  border-bottom: 1px solid var(--tab-active-bg);
  margin-bottom: -1px;
}

.tab-pin {
  color: var(--accent);
  flex-shrink: 0;
}

.tab-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.tab-icon-svg {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
}

.tab-icon-svg :deep(svg) {
  width: 16px;
  height: 16px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.tab-exit-badge {
  font-size: 10px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--danger);
  color: #fff;
  flex-shrink: 0;
}

.tab-exit-badge.exit-ok {
  background: var(--git-add);
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--danger);
  color: var(--text-active);
}

.tab-add-group {
  display: flex;
  flex-shrink: 0;
}

.tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--tabbar-height);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

.tab-add:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.tab-add-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-left: 1px solid var(--border);
}

.tab-add-arrow:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.shell-menu {
  position: absolute;
  right: 0;
  top: var(--tabbar-height);
  z-index: 1000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.shell-menu button {
  display: block;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.shell-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.tab-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}

.context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.context-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  gap: 16px;
}

.context-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.context-menu button:hover .ctx-key {
  color: rgba(255, 255, 255, 0.7);
}

.context-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}
</style>
