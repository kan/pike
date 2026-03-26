<script setup lang="ts">
import { watch, nextTick, ref } from "vue";
import { useShortcutsModal } from "../composables/useShortcutsModal";

const { visible } = useShortcutsModal();
const panelRef = ref<HTMLDivElement>();

watch(visible, (show) => {
  if (show) nextTick(() => panelRef.value?.focus());
});

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    visible.value = false;
  }
}

interface ShortcutSection {
  title: string;
  items: { keys: string; label: string }[];
}

const sections: ShortcutSection[] = [
  {
    title: "General",
    items: [
      { keys: "Ctrl+Shift+P", label: "Project Switcher" },
      { keys: "Ctrl+K", label: "Keyboard Shortcuts" },
      { keys: "Ctrl+,", label: "Settings" },
    ],
  },
  {
    title: "Tabs",
    items: [
      { keys: "Ctrl+T", label: "New Terminal" },
      { keys: "Ctrl+W", label: "Close Tab" },
      { keys: "Ctrl+PageDown", label: "Next Tab" },
      { keys: "Ctrl+PageUp", label: "Previous Tab" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: "Ctrl+S", label: "Save" },
      { keys: "Ctrl+Z", label: "Undo" },
      { keys: "Ctrl+Shift+Z", label: "Redo" },
      { keys: "Ctrl+F", label: "Find" },
      { keys: "Ctrl+H", label: "Find & Replace" },
      { keys: "Alt+H", label: "Git History" },
    ],
  },
  {
    title: "Terminal",
    items: [
      { keys: "Select text", label: "Copy to clipboard" },
      { keys: "Right click", label: "Paste from clipboard" },
    ],
  },
];
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="shortcuts-overlay"
      @mousedown.self="visible = false"
      @keydown="onKeyDown"
    >
      <div ref="panelRef" class="shortcuts-panel" tabindex="-1">
        <div class="shortcuts-header">
          <span class="shortcuts-title">Keyboard Shortcuts</span>
          <button class="close-btn" @click="visible = false">&times;</button>
        </div>
        <div class="shortcuts-body">
          <div v-for="section in sections" :key="section.title" class="shortcut-section">
            <h4 class="section-title">{{ section.title }}</h4>
            <div v-for="item in section.items" :key="item.keys" class="shortcut-row">
              <span class="shortcut-label">{{ item.label }}</span>
              <span class="shortcut-keys">
                <kbd v-for="(part, i) in item.keys.split('+')" :key="i">{{ part }}</kbd>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.shortcuts-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 60px;
}

.shortcuts-panel {
  width: 480px;
  max-height: 520px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
  outline: none;
}

.shortcuts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.shortcuts-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-active);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-active);
}

.shortcuts-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px 16px;
}

.shortcut-section {
  margin-bottom: 12px;
}

.shortcut-section:last-child {
  margin-bottom: 0;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 6px;
  letter-spacing: 0.5px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.shortcut-label {
  font-size: 13px;
  color: var(--text-primary);
}

.shortcut-keys {
  display: flex;
  gap: 3px;
}

kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  line-height: 1.4;
}
</style>
