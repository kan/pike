<script setup lang="ts">
import { useSidebarStore } from "../../stores/sidebar";
import type { SidebarPanel } from "../../types/tab";
import ProjectPanel from "../panels/ProjectPanel.vue";
import FileTreePanel from "../panels/FileTreePanel.vue";

const sidebar = useSidebarStore();

const icons: { panel: SidebarPanel; label: string; icon: string }[] = [
  { panel: "files", label: "Files", icon: "🗂" },
  { panel: "git", label: "Git", icon: "🌿" },
  { panel: "search", label: "Search", icon: "🔍" },
  { panel: "docker", label: "Docker", icon: "🐋" },
  { panel: "projects", label: "Projects", icon: "📁" },
];
</script>

<template>
  <div class="sidebar" :class="{ 'panel-open': sidebar.isPanelOpen }">
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
    <aside v-if="sidebar.isPanelOpen" class="panel">
      <div class="panel-header">
        {{ icons.find((i) => i.panel === sidebar.activePanel)?.label }}
      </div>
      <div class="panel-content">
        <ProjectPanel v-if="sidebar.activePanel === 'projects'" />
        <FileTreePanel v-else-if="sidebar.activePanel === 'files'" />
        <span v-else class="placeholder">{{ sidebar.activePanel }} panel (coming soon)</span>
      </div>
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
  width: var(--panel-width);
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

.placeholder {
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
