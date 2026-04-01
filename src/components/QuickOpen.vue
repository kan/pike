<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useProjectStore } from "../stores/project";
import { useTabStore } from "../stores/tabs";
import { listProjectFiles } from "../lib/tauri";
import { basename } from "../lib/paths";
import { useI18n } from "../i18n";

const { t } = useI18n();
const projectStore = useProjectStore();
const tabStore = useTabStore();

const query = ref("");
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement>();
const files = ref<string[]>([]);
const loading = ref(false);
let lastProjectId: string | null = null;

// Track recently opened files (persisted in memory for the session)
const recentFiles: string[] = [];
const MAX_RECENT = 20;

function trackRecent(path: string) {
  const idx = recentFiles.indexOf(path);
  if (idx !== -1) recentFiles.splice(idx, 1);
  recentFiles.unshift(path);
  if (recentFiles.length > MAX_RECENT) recentFiles.pop();
}

// Parse query: support "filename:lineNumber" syntax
const parsedQuery = computed(() => {
  const raw = query.value;
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx > 0) {
    const afterColon = raw.slice(colonIdx + 1);
    const lineNum = parseInt(afterColon, 10);
    if (!isNaN(lineNum) && lineNum > 0) {
      return { pattern: raw.slice(0, colonIdx), line: lineNum };
    }
  }
  return { pattern: raw, line: undefined };
});

function fuzzyMatch(text: string, pattern: string): boolean {
  let pi = 0;
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) pi++;
  }
  return pi === pattern.length;
}

const MAX_DISPLAY = 100;

const filtered = computed(() => {
  const p = parsedQuery.value.pattern.toLowerCase();
  const sep = files.value.length > 0 && files.value[0].includes("/") ? "/" : "\\";

  if (!p) {
    // Show recent files first, then all files
    const recent = recentFiles
      .filter((r) => files.value.includes(r))
      .slice(0, MAX_DISPLAY);
    if (recent.length >= MAX_DISPLAY) return recent;
    const recentSet = new Set(recent);
    const rest = files.value.filter((f) => !recentSet.has(f));
    return [...recent, ...rest].slice(0, MAX_DISPLAY);
  }

  // Fuzzy match on basename first, then full path
  const basenameMatches: string[] = [];
  const pathMatches: string[] = [];

  for (const f of files.value) {
    if (basenameMatches.length + pathMatches.length >= MAX_DISPLAY) break;
    const name = f.split(sep).pop()?.toLowerCase() ?? "";
    if (fuzzyMatch(name, p)) {
      basenameMatches.push(f);
    } else if (fuzzyMatch(f.toLowerCase(), p)) {
      pathMatches.push(f);
    }
  }

  // Sort recent files to top within matches
  const recentSet = new Set(recentFiles);
  const sortByRecent = (a: string, b: string) => {
    const aRecent = recentSet.has(a);
    const bRecent = recentSet.has(b);
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return 0;
  };

  basenameMatches.sort(sortByRecent);
  pathMatches.sort(sortByRecent);
  return [...basenameMatches, ...pathMatches].slice(0, MAX_DISPLAY);
});

async function loadFiles() {
  const project = projectStore.currentProject;
  if (!project) return;
  if (project.id === lastProjectId && files.value.length > 0) return;

  loading.value = true;
  try {
    files.value = await listProjectFiles(project.shell, project.root);
    lastProjectId = project.id;
  } catch {
    files.value = [];
  } finally {
    loading.value = false;
  }
}

function getDisplayPath(fullPath: string): string {
  const root = projectStore.currentProject?.root ?? "";
  if (root && fullPath.startsWith(root)) {
    let rel = fullPath.slice(root.length);
    if (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
    return rel;
  }
  return fullPath;
}

function openSelected() {
  const path = filtered.value[selectedIdx.value];
  if (!path) return;
  trackRecent(path);
  tabStore.addEditorTab({
    path,
    initialLine: parsedQuery.value.line,
  });
  projectStore.showQuickOpen = false;
}

watch(query, () => {
  selectedIdx.value = 0;
});

watch(
  () => projectStore.showQuickOpen,
  (show) => {
    if (show) {
      query.value = "";
      selectedIdx.value = 0;
      loadFiles();
      nextTick(() => inputRef.value?.focus());
    }
  }
);

// Invalidate cache when project changes
watch(
  () => projectStore.currentProject?.id,
  () => {
    lastProjectId = null;
    files.value = [];
  }
);

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    projectStore.showQuickOpen = false;
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (selectedIdx.value < filtered.value.length - 1) {
      selectedIdx.value++;
      scrollToSelected();
    }
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (selectedIdx.value > 0) {
      selectedIdx.value--;
      scrollToSelected();
    }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    openSelected();
    return;
  }
}

const listRef = ref<HTMLDivElement>();

function scrollToSelected() {
  nextTick(() => {
    const container = listRef.value;
    if (!container) return;
    const item = container.children[selectedIdx.value] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="projectStore.showQuickOpen" class="quickopen-overlay" @mousedown.self="projectStore.showQuickOpen = false">
      <div class="quickopen">
        <input
          ref="inputRef"
          v-model="query"
          class="quickopen-input"
          :placeholder="t('quickOpen.placeholder')"
          @keydown="onKeyDown"
        />
        <div ref="listRef" class="quickopen-list">
          <div v-if="loading" class="quickopen-empty">{{ t('common.loading') }}</div>
          <template v-else>
            <div
              v-for="(file, i) in filtered"
              :key="file"
              class="quickopen-item"
              :class="{ selected: i === selectedIdx }"
              @click="selectedIdx = i; openSelected()"
              @mouseenter="selectedIdx = i"
            >
              <span class="item-name">{{ basename(file) }}</span>
              <span class="item-path">{{ getDisplayPath(file) }}</span>
            </div>
            <div v-if="filtered.length === 0 && query" class="quickopen-empty">
              {{ t('quickOpen.noMatch') }}
            </div>
          </template>
        </div>
        <div class="quickopen-footer">
          <span class="hint">{{ t('quickOpen.enterOpen') }}</span>
          <span class="hint">{{ t('quickOpen.lineHint') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.quickopen-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}

.quickopen {
  width: 520px;
  max-height: 420px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
}

.quickopen-input {
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 14px;
  outline: none;
}

.quickopen-input::placeholder {
  color: var(--text-secondary);
}

.quickopen-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.quickopen-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  cursor: pointer;
}

.quickopen-item.selected {
  background: var(--accent);
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
  flex-shrink: 0;
}

.quickopen-item.selected .item-name {
  color: var(--text-active);
}

.item-path {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quickopen-item.selected .item-path {
  color: rgba(255, 255, 255, 0.7);
}

.quickopen-empty {
  padding: 16px 14px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.quickopen-footer {
  border-top: 1px solid var(--border);
  padding: 6px 14px;
  display: flex;
  gap: 16px;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
