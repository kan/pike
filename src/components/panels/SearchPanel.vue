<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useSearchStore } from "../../stores/search";
import { useProjectStore } from "../../stores/project";
import { useTabStore } from "../../stores/tabs";
import { Regex } from "lucide-vue-next";
import { useI18n } from "../../i18n";

const { t } = useI18n();

const searchStore = useSearchStore();
const projectStore = useProjectStore();
const tabStore = useTabStore();

const query = ref("");
const isRegex = ref(false);
const globInclude = ref("");
const globExclude = ref("");
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(), 300);
}

function doSearch() {
  if (!query.value.trim()) {
    searchStore.clear();
    return;
  }
  searchStore.search(
    query.value,
    isRegex.value,
    globInclude.value || undefined,
    globExclude.value || undefined,
  );
}

function openResult(match: { path: string; line: number }) {
  const project = projectStore.currentProject;
  if (!project) return;
  const s = project.shell.kind === "wsl" ? "/" : "\\";
  const fullPath = match.path.startsWith("/") || match.path.includes(":")
    ? match.path
    : project.root + s + match.path;
  tabStore.addEditorTab({ path: fullPath, initialLine: match.line });
}

function relativePath(fullPath: string): string {
  const root = projectStore.currentProject?.root;
  if (!root) return fullPath;
  const s = projectStore.currentProject?.shell?.kind === "wsl" ? "/" : "\\";
  if (fullPath.startsWith(root + s)) return fullPath.slice(root.length + s.length);
  return fullPath;
}

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

onMounted(() => {
  if (!searchStore.backend) {
    searchStore.detectBackend();
  }
});
</script>

<template>
  <div class="search-panel">
    <div class="search-input-area">
      <input
        v-model="query"
        class="search-input"
        :placeholder="t('search.placeholder')"
        @input="onInput"
        @keydown.enter="doSearch"
      />
      <div class="search-options">
        <button
          class="option-btn"
          :class="{ active: isRegex }"
          :title="t('search.useRegex')"
          @click="isRegex = !isRegex"
        ><Regex :size="14" :stroke-width="2" /></button>
        <input
          v-model="globInclude"
          class="glob-input"
          :placeholder="t('search.include')"
        />
        <input
          v-model="globExclude"
          class="glob-input"
          :placeholder="t('search.exclude')"
        />
      </div>
    </div>

    <div v-if="searchStore.backend" class="backend-badge">{{ searchStore.backend }}</div>

    <div v-if="searchStore.searching" class="status">{{ t('search.searching') }}</div>
    <div v-else-if="searchStore.error" class="status error">{{ searchStore.error }}</div>
    <div v-else-if="!searchStore.results.length && query" class="status">{{ t('search.noResults') }}</div>

    <div class="results-list">
      <div
        v-for="(match, i) in searchStore.results"
        :key="i"
        class="result-item"
        @click="openResult(match)"
      >
        <div class="result-location">
          <span class="result-path">{{ relativePath(match.path) }}</span>
          <span class="result-line">:{{ match.line }}</span>
        </div>
        <div class="result-content">{{ match.content }}</div>
      </div>
    </div>

    <div v-if="searchStore.truncated" class="status truncated">
      {{ t('search.truncated') }}
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-input-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  border-radius: 3px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.search-options {
  display: flex;
  gap: 4px;
  align-items: center;
}

.option-btn {
  padding: 2px 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.option-btn.active {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}

.glob-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  border-radius: 3px;
  outline: none;
}

.glob-input:focus {
  border-color: var(--accent);
}

.results-list {
  display: flex;
  flex-direction: column;
}

.result-item {
  padding: 4px 4px;
  cursor: pointer;
  border-radius: 3px;
}

.result-item:hover {
  background: var(--tab-hover-bg);
}

.result-location {
  font-size: 11px;
}

.result-path {
  color: var(--accent);
}

.result-line {
  color: var(--text-secondary);
}

.result-content {
  font-size: 12px;
  font-family: "PlemolJP Console NF", "Cascadia Code", monospace;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 8px 0;
}

.status.error {
  color: var(--danger);
}

.status.truncated {
  font-size: 11px;
  padding: 4px 0;
}

.backend-badge {
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 3px;
  padding: 1px 6px;
  align-self: flex-start;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
</style>
