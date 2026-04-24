<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '../../../i18n'
import { relativeDate } from '../../../lib/paths'
import { gitDiffCommit, gitLogFile } from '../../../lib/tauri'
import { useProjectStore } from '../../../stores/project'
import { useTabStore } from '../../../stores/tabs'
import type { GitLogEntry } from '../../../types/git'

const props = defineProps<{ filePath: string }>()

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()

const entries = ref<GitLogEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

// Bumped on every load start — in-flight loads for a stale path are discarded.
let loadToken = 0

watch(
  () => props.filePath,
  (path) => loadHistory(path),
  { immediate: true },
)

async function loadHistory(path: string) {
  const token = ++loadToken
  const project = projectStore.currentProject
  if (!project || !path) {
    entries.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    const result = await gitLogFile(project.root, project.shell, path, 200)
    if (token !== loadToken) return
    entries.value = result
  } catch (e) {
    if (token !== loadToken) return
    entries.value = []
    error.value = String(e)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

async function openCommitDiff(hash: string) {
  const project = projectStore.currentProject
  if (!project) return
  try {
    const diff = await gitDiffCommit(project.root, project.shell, hash, props.filePath)
    tabStore.addDiffTab({ filePath: props.filePath, diff, commitHash: hash })
  } catch (e) {
    error.value = String(e)
  }
}
</script>

<template>
  <div class="outline-history">
    <div v-if="loading" class="status">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="status error">{{ error }}</div>
    <div v-else-if="!entries.length" class="status">{{ t('history.noHistory') }}</div>
    <div v-else class="commit-list">
      <div
        v-for="entry in entries"
        :key="entry.hash"
        class="commit-row"
        :title="`${entry.hash}\n${entry.author}\n${entry.date}\n\n${entry.message}`"
        @click="openCommitDiff(entry.hash)"
      >
        <span class="c-hash">{{ entry.hash.slice(0, 7) }}</span>
        <span class="c-msg">{{ entry.message.split('\n')[0] }}</span>
        <span class="c-meta">
          <span class="c-author">{{ entry.author }}</span>
          <span class="c-date">{{ relativeDate(entry.date) }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outline-history {
  height: 100%;
  overflow-y: auto;
}

.commit-list {
  display: flex;
  flex-direction: column;
}

.commit-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}

.commit-row:hover {
  background: var(--tab-hover-bg);
}

.c-hash {
  font-family: monospace;
  font-size: 10px;
  color: var(--accent);
}

.c-msg {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-meta {
  display: flex;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 10px;
}

.c-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.c-date {
  flex-shrink: 0;
}

.status {
  padding: 16px 8px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.status.error {
  color: var(--diff-del, #e06c75);
  white-space: pre-wrap;
  text-align: left;
}
</style>
