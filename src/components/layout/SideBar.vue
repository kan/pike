<script setup lang="ts">
import { ref, nextTick, onUnmounted, type Component } from "vue";
import { useSidebarStore } from "../../stores/sidebar";
import { useGitStore } from "../../stores/git";
import type { SidebarPanel } from "../../types/tab";
import ProjectPanel from "../panels/ProjectPanel.vue";
import FileTreePanel from "../panels/FileTreePanel.vue";
import GitPanel from "../panels/GitPanel.vue";
import DockerPanel from "../panels/DockerPanel.vue";
import SearchPanel from "../panels/SearchPanel.vue";
import { useSearchStore } from "../../stores/search";
import { useDockerStore } from "../../stores/docker";
import { Files, GitBranch, Search, Container, FolderOpen, RefreshCw, ArrowDown, ArrowUp, Loader, Settings } from "lucide-vue-next";
import { useTabStore } from "../../stores/tabs";
import { useShortcutsModal } from "../../composables/useShortcutsModal";

const sidebar = useSidebarStore();
const tabStore = useTabStore();
const gitStore = useGitStore();
const searchStore = useSearchStore();
const dockerStore = useDockerStore();
const shortcutsModal = useShortcutsModal();
const showGearMenu = ref(false);

function onGearClick() {
  showGearMenu.value = !showGearMenu.value;
  if (showGearMenu.value) {
    nextTick(() => {
      window.addEventListener("mousedown", closeGearMenu, { once: true });
    });
  } else {
    window.removeEventListener("mousedown", closeGearMenu);
  }
}

function closeGearMenu() {
  window.removeEventListener("mousedown", closeGearMenu);
  showGearMenu.value = false;
}

function openShortcuts() {
  closeGearMenu();
  shortcutsModal.toggle();
}

function openSettings() {
  closeGearMenu();
  tabStore.addSettingsTab();
}

const fileTreeRef = ref<{ refresh: () => void; refreshing: boolean } | null>(null);

const icons: { panel: SidebarPanel; label: string; icon: Component }[] = [
  { panel: "files", label: "Files", icon: Files },
  { panel: "git", label: "Git", icon: GitBranch },
  { panel: "search", label: "Search", icon: Search },
  { panel: "docker", label: "Docker", icon: Container },
  { panel: "projects", label: "Projects", icon: FolderOpen },
];

let dragging = false;
let startX = 0;
let startWidth = 0;

function onResizeStart(e: MouseEvent) {
  dragging = true;
  startX = e.clientX;
  startWidth = sidebar.panelWidth;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function onResizeMove(e: MouseEvent) {
  if (!dragging) return;
  sidebar.setPanelWidth(startWidth + (e.clientX - startX));
}

function onResizeEnd() {
  dragging = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

onUnmounted(() => {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
  window.removeEventListener("mousedown", closeGearMenu);
});
</script>

<template>
  <div class="sidebar">
    <nav class="icon-strip">
      <button
        v-for="item in icons"
        :key="item.panel"
        class="icon-button"
        :class="{ active: sidebar.activePanel === item.panel }"
        :title="item.label"
        @click="sidebar.togglePanel(item.panel)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" class="icon" />
      </button>
      <div class="icon-spacer" />
      <div class="gear-wrapper">
        <div v-if="showGearMenu" class="gear-menu" @mousedown.stop>
          <button class="gear-menu-item" @click="openShortcuts">
            <span>Keyboard Shortcuts</span>
            <span class="ctx-key">Ctrl+K</span>
          </button>
          <button class="gear-menu-item" @click="openSettings">
            <span>Settings</span>
            <span class="ctx-key">Ctrl+,</span>
          </button>
        </div>
        <button
          class="icon-button"
          title="Settings"
          @click="onGearClick"
        >
          <Settings :size="22" :stroke-width="1.5" class="icon" />
        </button>
      </div>
    </nav>
    <aside v-if="sidebar.isPanelOpen" class="panel" :style="{ width: sidebar.panelWidth + 'px' }">
      <div class="panel-header">
        <span>{{ icons.find((i) => i.panel === sidebar.activePanel)?.label }}</span>
        <div v-if="sidebar.activePanel === 'files'" class="header-actions">
          <button class="header-btn" title="Refresh" @click="fileTreeRef?.refresh()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: fileTreeRef?.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'search'" class="header-actions">
          <span class="backend-badge">{{ searchStore.backend ?? '...' }}</span>
        </div>
        <div v-if="sidebar.activePanel === 'git'" class="header-actions">
          <button class="header-btn" :disabled="gitStore.pulling" title="Pull" @click="gitStore.pull()">
            <Loader v-if="gitStore.pulling" :size="14" :stroke-width="2" class="spin" />
            <ArrowDown v-else :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :disabled="gitStore.pushing" title="Push" @click="gitStore.push()">
            <Loader v-if="gitStore.pushing" :size="14" :stroke-width="2" class="spin" />
            <ArrowUp v-else :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :disabled="gitStore.refreshing" title="Refresh" @click="gitStore.refreshStatus(true); gitStore.refreshLog()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: gitStore.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'docker'" class="header-actions">
          <button class="header-btn" :disabled="dockerStore.refreshing" title="Refresh" @click="dockerStore.refreshContainers(true)">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: dockerStore.refreshing }" />
          </button>
        </div>
      </div>
      <div class="panel-content">
        <ProjectPanel v-if="sidebar.activePanel === 'projects'" />
        <FileTreePanel v-else-if="sidebar.activePanel === 'files'" ref="fileTreeRef" />
        <GitPanel v-else-if="sidebar.activePanel === 'git'" />
        <SearchPanel v-else-if="sidebar.activePanel === 'search'" />
        <DockerPanel v-else-if="sidebar.activePanel === 'docker'" />
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
  background: var(--bg-secondary);
}

.icon-spacer {
  flex: 1;
}

.gear-wrapper {
  position: relative;
}

.gear-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  min-width: 200px;
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
</style>
