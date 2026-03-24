<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useGitStore } from "../../stores/git";
import { useProjectStore } from "../../stores/project";
import { useSidebarStore } from "../../stores/sidebar";

const gitStore = useGitStore();
const projectStore = useProjectStore();
const sidebar = useSidebarStore();

const commitMsg = ref("");
const showLog = ref(false);

function statusColor(s: string): string {
  switch (s) {
    case "M": return "var(--git-modify)";
    case "A": return "var(--git-add)";
    case "D": return "var(--git-delete)";
    case "R": return "var(--accent)";
    default:  return "var(--git-untracked)";
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "";
}

async function onCommit() {
  if (!commitMsg.value.trim() || !gitStore.status?.staged.length) return;
  await gitStore.commitChanges(commitMsg.value.trim());
  commitMsg.value = "";
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function refreshIfActive() {
  if (sidebar.activePanel === "git" && projectStore.currentProject) {
    gitStore.refreshStatus();
    gitStore.refreshLog();
  }
}

watch(() => sidebar.activePanel, refreshIfActive);
watch(() => projectStore.currentProject, () => {
  gitStore.selectedDiff = null;
  refreshIfActive();
});

onMounted(refreshIfActive);
</script>

<template>
  <div class="git-panel">
    <template v-if="!projectStore.currentProject">
      <div class="empty">No project selected</div>
    </template>

    <template v-else-if="gitStore.error">
      <div class="empty">{{ gitStore.error }}</div>
    </template>

    <template v-else-if="gitStore.status">
      <!-- Commit -->
      <div class="commit-section">
        <textarea
          v-model="commitMsg"
          class="commit-input"
          placeholder="Commit message..."
          rows="2"
        ></textarea>
        <button
          class="commit-btn"
          :disabled="!commitMsg.trim() || !gitStore.status.staged.length"
          @click="onCommit"
        >Commit ({{ gitStore.status.staged.length }})</button>
      </div>

      <!-- Staged -->
      <div v-if="gitStore.status.staged.length" class="file-section">
        <div class="section-header">
          <span>Staged ({{ gitStore.status.staged.length }})</span>
          <button class="section-action" @click="gitStore.unstageFiles(gitStore.status!.staged.map(f => f.path))">
            Unstage All
          </button>
        </div>
        <div
          v-for="file in gitStore.status.staged"
          :key="'s-' + file.path"
          class="file-item"
          :class="{ selected: gitStore.selectedDiff?.path === file.path && gitStore.selectedDiff?.staged }"
          @click="gitStore.loadDiff(file.path, true)"
        >
          <span class="file-status" :style="{ color: statusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path">{{ file.path }}</span>
          <button class="file-action" title="Unstage" @click.stop="gitStore.unstageFiles([file.path])">-</button>
        </div>
      </div>

      <!-- Unstaged -->
      <div v-if="gitStore.status.unstaged.length" class="file-section">
        <div class="section-header">
          <span>Changes ({{ gitStore.status.unstaged.length }})</span>
          <button class="section-action" @click="gitStore.stageFiles(gitStore.status!.unstaged.map(f => f.path))">
            Stage All
          </button>
        </div>
        <div
          v-for="file in gitStore.status.unstaged"
          :key="'u-' + file.path"
          class="file-item"
          :class="{ selected: gitStore.selectedDiff?.path === file.path && !gitStore.selectedDiff?.staged }"
          @click="gitStore.loadDiff(file.path, false)"
        >
          <span class="file-status" :style="{ color: statusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path">{{ file.path }}</span>
          <button class="file-action" title="Stage" @click.stop="gitStore.stageFiles([file.path])">+</button>
        </div>
      </div>

      <!-- Diff -->
      <div v-if="gitStore.selectedDiff" class="diff-section">
        <div class="diff-header">{{ gitStore.selectedDiff.path }}</div>
        <pre class="diff-content"><template v-for="(line, i) in gitStore.selectedDiff.diff.split('\n')" :key="i"><span :class="diffLineClass(line)">{{ line }}
</span></template></pre>
      </div>

      <!-- No changes -->
      <div v-if="!gitStore.status.staged.length && !gitStore.status.unstaged.length" class="empty">
        No changes
      </div>

      <!-- Log -->
      <div class="file-section">
        <div class="section-header clickable" @click="showLog = !showLog">
          <span>{{ showLog ? "v" : ">" }} Recent Commits</span>
        </div>
        <div v-if="showLog" class="log-list">
          <div v-for="entry in gitStore.logEntries" :key="entry.hash" class="log-item">
            <span class="log-hash">{{ entry.hash.slice(0, 7) }}</span>
            <span class="log-message">{{ entry.message }}</span>
            <span class="log-meta">{{ entry.author }}, {{ relativeDate(entry.date) }}</span>
          </div>
          <div v-if="!gitStore.logEntries.length" class="empty">No commits</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="empty">Loading...</div>
    </template>
  </div>
</template>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.commit-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.commit-input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  border-radius: 3px;
  outline: none;
  resize: vertical;
  min-height: 36px;
}

.commit-input:focus {
  border-color: var(--accent);
}

.commit-btn {
  padding: 5px 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.commit-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.file-section {
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
}

.section-header.clickable {
  cursor: pointer;
}

.section-header.clickable:hover {
  color: var(--text-primary);
}

.section-action {
  padding: 1px 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  border-radius: 2px;
}

.section-action:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}

.file-item:hover {
  background: var(--tab-hover-bg);
}

.file-item.selected {
  background: var(--bg-tertiary);
}

.file-status {
  font-family: monospace;
  font-size: 11px;
  font-weight: 600;
  width: 12px;
  text-align: center;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.file-action {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-family: monospace;
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  flex-shrink: 0;
}

.file-item:hover .file-action {
  opacity: 1;
}

.file-action:hover {
  background: var(--accent);
  color: var(--text-active);
}

.diff-section {
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.diff-header {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}

.diff-content {
  margin: 0;
  padding: 4px 8px;
  font-size: 11px;
  font-family: "PlemolJP Console NF", "Cascadia Code", monospace;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 300px;
  overflow-y: auto;
  background: var(--bg-primary);
}

.diff-add {
  color: var(--git-add);
}

.diff-del {
  color: var(--git-delete);
}

.diff-hunk {
  color: var(--accent);
}

.log-list {
  display: flex;
  flex-direction: column;
}

.log-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 4px;
  font-size: 12px;
}

.log-hash {
  font-family: monospace;
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
}

.log-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.log-meta {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  white-space: nowrap;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>
