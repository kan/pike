<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../i18n'
import { parseDiff } from '../../lib/diffParser'
import { useTabStore } from '../../stores/tabs'
import type { DiffTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()

const tab = computed(() => tabStore.tabs.find((t): t is DiffTab => t.id === props.tabId && t.kind === 'diff'))

const parsedLines = computed(() => (tab.value ? parseDiff(tab.value.diff, { charLevel: true }) : []))
</script>

<template>
  <div class="diff-tab">
    <div v-if="!tab" class="empty">{{ t('diff.notFound') }}</div>
    <div v-else-if="!parsedLines.length && tab.diff" class="empty">
      {{ tab.diff.includes('Binary files') ? t('diff.binary') : tab.diff.slice(0, 200) }}
    </div>
    <div v-else-if="!parsedLines.length" class="empty">{{ t('diff.noChanges') }}</div>
    <div v-else class="diff-container">
      <table class="diff-table">
        <tbody>
          <tr v-for="(row, i) in parsedLines" :key="i" class="diff-row">
            <td class="line-num" :class="row.left.type">{{ row.left.num ?? "" }}</td>
            <td class="line-content" :class="row.left.type"><template
              v-for="(seg, j) in row.left.segments" :key="j"
            ><span :class="{ 'hl': seg.highlight }">{{ seg.text }}</span></template></td>
            <td class="line-num" :class="row.right.type">{{ row.right.num ?? "" }}</td>
            <td class="line-content" :class="row.right.type"><template
              v-for="(seg, j) in row.right.segments" :key="j"
            ><span :class="{ 'hl': seg.highlight }">{{ seg.text }}</span></template></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-tab {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--bg-primary);
}

.diff-container {
  min-width: 100%;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.5;
  table-layout: fixed;
}

.diff-row {
  height: 20px;
}

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

.line-content:nth-child(2) {
  border-right: 1px solid var(--border);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.del .hl {
  background: rgba(244, 71, 71, 0.3);
  border-radius: 2px;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.add .hl {
  background: rgba(78, 201, 176, 0.3);
  border-radius: 2px;
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.empty {
  background: var(--bg-secondary);
}

.diff-tab > .empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
