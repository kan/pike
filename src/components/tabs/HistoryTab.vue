<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { relativeDate } from '../../lib/paths'
import { gitDiffCommit, gitLogFile } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { GitLogEntry } from '../../types/git'
import type { HistoryTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const tab = computed(() => tabStore.tabs.find((t): t is HistoryTab => t.id === props.tabId && t.kind === 'history'))

const entries = ref<GitLogEntry[]>([])
const loading = ref(true)
const selectedHash = ref<string | null>(null)
const diffText = ref('')
const diffLoading = ref(false)

interface DiffLine {
  left: { num: number | null; text: string; type: string }
  right: { num: number | null; text: string; type: string }
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let leftNum = 0,
    rightNum = 0,
    inHunk = false

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        leftNum = parseInt(match[1], 10) - 1
        rightNum = parseInt(match[2], 10) - 1
      }
      inHunk = true
      result.push({
        left: { num: null, text: line, type: 'hunk' },
        right: { num: null, text: '', type: 'hunk' },
      })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('-')) {
      leftNum++
      result.push({
        left: { num: leftNum, text: line.slice(1), type: 'del' },
        right: { num: null, text: '', type: 'empty' },
      })
    } else if (line.startsWith('+')) {
      rightNum++
      // Pair with preceding unpaired del
      let paired = -1
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].left.type === 'del' && result[i].right.type === 'empty') {
          paired = i
          break
        }
        if (result[i].left.type !== 'del') break
      }
      if (paired !== -1) {
        result[paired].right = { num: rightNum, text: line.slice(1), type: 'add' }
      } else {
        result.push({
          left: { num: null, text: '', type: 'empty' },
          right: { num: rightNum, text: line.slice(1), type: 'add' },
        })
      }
    } else if (!line.startsWith('\\')) {
      leftNum++
      rightNum++
      result.push({
        left: { num: leftNum, text: line.slice(1), type: 'ctx' },
        right: { num: rightNum, text: line.slice(1), type: 'ctx' },
      })
    }
  }
  return result
}

const diffLines = computed(() => parseDiff(diffText.value))

const copiedHash = ref<string | null>(null)

function copyHash(hash: string) {
  navigator.clipboard.writeText(hash)
  copiedHash.value = hash
  setTimeout(() => {
    copiedHash.value = null
  }, 1500)
}

async function selectCommit(hash: string) {
  const project = projectStore.currentProject
  if (!project || !tab.value) return
  selectedHash.value = hash
  diffLoading.value = true
  try {
    diffText.value = await gitDiffCommit(project.root, project.shell, hash, tab.value.filePath)
  } catch (e) {
    diffText.value = String(e)
  } finally {
    diffLoading.value = false
  }
}

onMounted(async () => {
  const project = projectStore.currentProject
  if (!project || !tab.value) return
  try {
    entries.value = await gitLogFile(project.root, project.shell, tab.value.filePath, 200)
  } catch {
    entries.value = []
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="history-tab">
    <div v-if="!tab" class="status">{{ t('history.notFound') }}</div>
    <template v-else>
      <!-- Top: commit list -->
      <div class="commit-list">
        <div v-if="loading" class="status">{{ t('common.loading') }}</div>
        <div v-else-if="!entries.length" class="status">{{ t('history.noHistory') }}</div>
        <div
          v-for="entry in entries"
          :key="entry.hash"
          class="commit-row"
          :class="{ selected: entry.hash === selectedHash }"
          :title="`${entry.hash}\n${entry.author}\n${entry.date}\n\n${entry.message}`"
          @click="selectCommit(entry.hash)"
        >
          <span class="c-hash" :title="copiedHash === entry.hash ? t('common.copied') : 'Click to copy'" @click.stop="copyHash(entry.hash)">{{ copiedHash === entry.hash ? t('common.copied') : entry.hash.slice(0, 7) }}</span>
          <span class="c-msg">{{ entry.message.split('\n')[0] }}</span>
          <span class="c-author">{{ entry.author }}</span>
          <span class="c-date">{{ relativeDate(entry.date) }}</span>
        </div>
      </div>

      <!-- Bottom: diff view -->
      <div class="diff-area">
        <div v-if="!selectedHash" class="status">{{ t('history.selectCommit') }}</div>
        <div v-else-if="diffLoading" class="status">{{ t('history.loadingDiff') }}</div>
        <div v-else-if="!diffLines.length && diffText" class="status">{{ diffText.slice(0, 200) }}</div>
        <table v-else class="diff-table">
          <tbody>
            <tr v-for="(row, i) in diffLines" :key="i" class="diff-row">
              <td class="line-num" :class="row.left.type">{{ row.left.num ?? "" }}</td>
              <td class="line-content" :class="row.left.type">{{ row.left.text }}</td>
              <td class="line-num" :class="row.right.type">{{ row.right.num ?? "" }}</td>
              <td class="line-content" :class="row.right.type">{{ row.right.text }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
}

.commit-list {
  flex: 0 0 40%;
  overflow-y: auto;
  border-bottom: 2px solid var(--border);
}

.commit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}

.commit-row:hover {
  background: var(--tab-hover-bg);
}

.commit-row.selected {
  background: var(--bg-tertiary);
}

.c-hash {
  font-family: monospace;
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
  width: 56px;
  cursor: pointer;
  border-radius: 2px;
}

.c-hash:hover {
  background: var(--accent);
  color: var(--text-active);
}

.c-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.c-author {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-date {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  width: 60px;
  text-align: right;
}

.diff-area {
  flex: 1;
  overflow: auto;
}

.status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 60px;
  color: var(--text-secondary);
  font-size: 13px;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.5;
  table-layout: fixed;
}

.diff-row { height: 20px; }

.line-num {
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--border);
  font-size: 11px;
}

.line-content {
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
}

.line-content:nth-child(2) { border-right: 1px solid var(--border); }

.del { background: rgba(244, 71, 71, 0.1); }
.add { background: rgba(78, 201, 176, 0.1); }
.hunk { background: rgba(0, 122, 204, 0.08); color: var(--accent); }
.empty { background: var(--bg-secondary); }
</style>
