<script setup lang="ts">
import { onUnmounted } from "vue";
import { useSidebarStore } from "../../stores/sidebar";
import type { SidebarPanel } from "../../types/tab";
import ProjectPanel from "../panels/ProjectPanel.vue";
import FileTreePanel from "../panels/FileTreePanel.vue";
import GitPanel from "../panels/GitPanel.vue";

const sidebar = useSidebarStore();

const icons: { panel: SidebarPanel; label: string; icon: string }[] = [
  { panel: "files", label: "Files", icon: "🗂" },
  { panel: "git", label: "Git", icon: "🌿" },
  { panel: "search", label: "Search", icon: "🔍" },
  { panel: "docker", label: "Docker", icon: "🐋" },
  { panel: "projects", label: "Projects", icon: "📁" },
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
        <span class="icon">{{ item.icon }}</span>
      </button>
    </nav>
    <aside v-if="sidebar.isPanelOpen" class="panel" :style="{ width: sidebar.panelWidth + 'px' }">
      <div class="panel-header">
        {{ icons.find((i) => i.panel === sidebar.activePanel)?.label }}
      </div>
      <div class="panel-content">
        <ProjectPanel v-if="sidebar.activePanel === 'projects'" />
        <FileTreePanel v-else-if="sidebar.activePanel === 'files'" />
        <GitPanel v-else-if="sidebar.activePanel === 'git'" />
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
  background: var(--bg-secondary);
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
  font-size: 20px;
  line-height: 1;
}

.panel {
  position: relative;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
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
