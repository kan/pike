<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import { useTabStore } from "../../stores/tabs";
import type { Tab } from "../../types/tab";
import TerminalTab from "../tabs/TerminalTab.vue";

const tabStore = useTabStore();

const terminalTabs = computed(() =>
  tabStore.tabs.filter((t) => t.kind === "terminal")
);

function kindIcon(kind: Tab["kind"]): string {
  switch (kind) {
    case "terminal":
      return ">";
    case "editor":
      return "#";
    case "docker-logs":
      return "~";
  }
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
      <button class="tab-add" title="New Terminal (Ctrl+T)" @click="tabStore.addTerminalTab()">
        +
      </button>
    </div>

    <!-- Tab Content -->
    <div class="tab-content">
      <TerminalTab
        v-for="tab in terminalTabs"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="tab.id === tabStore.activeTabId"
      />

      <!-- Empty state -->
      <div v-if="tabStore.tabs.length === 0" class="empty-state">
        Press Ctrl+T to open a terminal
      </div>
    </div>

    <!-- Context Menu -->
    <div
      v-if="contextMenu && contextTab"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
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
}

.tabs-scroll {
  display: flex;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}

/* Hide scrollbar but keep scrollable */
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
