<script setup lang="ts">
import { ref, computed, nextTick, onUnmounted } from "vue";
import { useTabStore } from "../../stores/tabs";
import { useProjectStore } from "../../stores/project";
import type { Tab, ShellType } from "../../types/tab";
import { isWindowsShell, WINDOWS_SHELLS, shellToType } from "../../types/tab";
import TerminalTab from "../tabs/TerminalTab.vue";
import DiffTab from "../tabs/DiffTab.vue";
import EditorTab from "../tabs/EditorTab.vue";
import PreviewTab from "../tabs/PreviewTab.vue";
import HistoryTab from "../tabs/HistoryTab.vue";

const tabStore = useTabStore();
const projectStore = useProjectStore();

const terminalTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "terminal")
);

const diffTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "diff")
);

const editorTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "editor")
);

const previewTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "preview")
);

const historyTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "history")
);

const isWindows = computed(() =>
  projectStore.currentProject
    ? isWindowsShell(projectStore.currentProject.shell)
    : false
);

function kindIcon(kind: Tab["kind"]): string {
  switch (kind) {
    case "terminal":
      return ">";
    case "editor":
      return "#";
    case "docker-logs":
      return "~";
    case "diff":
      return "d";
    case "preview":
      return "P";
    case "history":
      return "H";
  }
}

function addTab(shellOverride?: ShellType) {
  const project = projectStore.currentProject;
  tabStore.addTerminalTab(
    project
      ? { cwd: project.root, shell: shellOverride ?? project.shell }
      : undefined
  );
}

// Shell dropdown for Windows projects
const showShellMenu = ref(false);

function toggleShellMenu() {
  if (showShellMenu.value) {
    closeShellMenu();
    return;
  }
  showShellMenu.value = true;
  nextTick(() => {
    window.addEventListener("mousedown", closeShellMenu, { once: true });
  });
}

function closeShellMenu() {
  window.removeEventListener("mousedown", closeShellMenu);
  showShellMenu.value = false;
}

function addTabWithShell(kind: 'cmd' | 'powershell' | 'git-bash') {
  addTab(shellToType(kind));
  closeShellMenu();
}

// Context menu
const contextMenu = ref<{ x: number; y: number; tabId: string } | null>(null);
const contextTab = computed(() =>
  contextMenu.value
    ? tabStore.tabs.find((t) => t.id === contextMenu.value!.tabId) ?? null
    : null
);

function onTabContextMenu(e: MouseEvent, tabId: string) {
  e.preventDefault();
  window.removeEventListener("mousedown", closeContextMenu);
  contextMenu.value = { x: e.clientX, y: e.clientY, tabId };
  nextTick(() => {
    window.addEventListener("mousedown", closeContextMenu, { once: true });
  });
}

function closeContextMenu() {
  contextMenu.value = null;
}

onUnmounted(() => {
  window.removeEventListener("mousedown", closeShellMenu);
  window.removeEventListener("mousedown", closeContextMenu);
});
</script>

<template>
  <div class="tab-pane">
    <!-- Tab Bar -->
    <div class="tab-bar">
      <div class="tabs-scroll">
        <div
          v-for="tab in tabStore.tabs"
          :key="tab.id"
          class="tab"
          :class="{ active: tab.id === tabStore.activeTabId }"
          @click="tabStore.setActiveTab(tab.id)"
          @mousedown.middle.prevent="tabStore.closeTab(tab.id)"
          @contextmenu="onTabContextMenu($event, tab.id)"
        >
          <span v-if="tab.pinned" class="tab-pin" title="Pinned">*</span>
          <span class="tab-icon">{{ kindIcon(tab.kind) }}</span>
          <span class="tab-title">{{ tab.title }}</span>
          <button
            v-if="!tab.pinned"
            class="tab-close"
            title="Close"
            @click.stop="tabStore.closeTab(tab.id)"
          >
            x
          </button>
        </div>
      </div>
      <div class="tab-add-group">
        <button class="tab-add" title="New Terminal (Ctrl+T)" @click="addTab()">+</button>
        <button
          v-if="isWindows"
          class="tab-add-arrow"
          title="Open with different shell"
          @click.stop="toggleShellMenu"
        >v</button>
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

      <!-- Empty state -->
      <div v-if="tabStore.tabs.length === 0" class="empty-state">
        <template v-if="projectStore.currentProject">
          Press Ctrl+T to open a terminal
        </template>
        <template v-else>
          Open a project to get started (Ctrl+Shift+P)
        </template>
      </div>
    </div>

    <!-- Context Menu -->
    <div
      v-if="contextMenu && contextTab"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @mousedown.stop
    >
      <button @click="tabStore.togglePin(contextMenu!.tabId); closeContextMenu()">
        {{ contextTab.pinned ? 'Unpin Tab' : 'Pin Tab' }}
      </button>
      <button
        v-if="!contextTab.pinned"
        @click="tabStore.closeTab(contextMenu!.tabId); closeContextMenu()"
      >
        Close Tab
      </button>
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

.tab.active {
  background: var(--tab-active-bg);
  color: var(--text-active);
  border-bottom: 1px solid var(--tab-active-bg);
  margin-bottom: -1px;
}

.tab-pin {
  color: var(--accent);
  font-size: 14px;
  flex-shrink: 0;
}

.tab-icon {
  flex-shrink: 0;
  font-family: monospace;
  font-size: 11px;
  opacity: 0.6;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
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
  font-size: 12px;
  font-family: monospace;
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
  font-size: 18px;
  font-family: monospace;
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
  font-size: 10px;
  font-family: monospace;
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

.context-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}
</style>
