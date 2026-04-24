<script setup lang="ts">
import { EditorView } from '@codemirror/view'
import { computed, nextTick, ref, watch } from 'vue'
import { useOutlineSource } from '../../composables/useOutlineSource'
import { useI18n } from '../../i18n'
import { extractOutline, type OutlineNode, type OutlineResult } from '../../lib/outline'
import { basename } from '../../lib/paths'
import OutlineTreeView from './outline/OutlineTreeView.vue'

const { t } = useI18n()
const outlineSource = useOutlineSource()

type OutlineTab = 'outline' | 'history'
const activeTab = ref<OutlineTab>('outline')

const result = ref<OutlineResult | null>(null)
const debouncedVersion = ref(0)
let versionTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => outlineSource.current.value?.version,
  () => {
    if (versionTimer) clearTimeout(versionTimer)
    versionTimer = setTimeout(() => {
      debouncedVersion.value++
    }, 250)
  },
)

watch([() => outlineSource.current.value?.tabId, debouncedVersion], () => recompute(), { immediate: true })

function recompute() {
  const src = outlineSource.current.value
  if (!src) {
    result.value = null
    return
  }
  if (!src.path) {
    result.value = null
    return
  }
  const text = src.view.state.doc.toString()
  result.value = extractOutline(text, {
    filename: basename(src.path),
    langId: src.langId,
    state: src.view.state,
  })
}

function onSelect(node: OutlineNode) {
  const src = outlineSource.current.value
  if (!src) return
  const view = src.view
  const totalLines = view.state.doc.lines
  const lineNum = Math.max(1, Math.min(node.line, totalLines))
  const line = view.state.doc.line(lineNum)
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  })
  view.focus()
}

type Status = 'no-source' | 'untitled' | 'too-large' | 'unsupported' | 'empty' | 'ok'

const status = computed<Status>(() => {
  const src = outlineSource.current.value
  if (!src) return 'no-source'
  if (!src.path) return 'untitled'
  const r = result.value
  if (!r) return 'no-source'
  if (r.kind === 'too-large') return 'too-large'
  if (r.kind === 'unsupported') return 'unsupported'
  if (r.nodes.length === 0) return 'empty'
  return 'ok'
})

const nodes = computed<OutlineNode[]>(() => (result.value?.kind === 'ok' ? result.value.nodes : []))

const bodyRef = ref<HTMLDivElement | null>(null)

function onBodyScroll() {
  const tabId = outlineSource.current.value?.tabId
  if (!tabId || !bodyRef.value) return
  outlineSource.scrollPositions.set(tabId, bodyRef.value.scrollTop)
}

watch(
  () => outlineSource.current.value?.tabId,
  async (tabId) => {
    if (!tabId) return
    await nextTick()
    if (!bodyRef.value) return
    bodyRef.value.scrollTop = outlineSource.scrollPositions.get(tabId) ?? 0
  },
)
</script>

<template>
  <div class="outline-panel">
    <div class="outline-tabs">
      <button
        class="outline-tab"
        :class="{ active: activeTab === 'outline' }"
        @click="activeTab = 'outline'"
      >
        {{ t('outline.tabOutline') }}
      </button>
      <button
        class="outline-tab"
        :class="{ active: activeTab === 'history' }"
        disabled
        :title="'Coming soon'"
      >
        {{ t('outline.tabHistory') }}
      </button>
    </div>
    <div class="outline-body" ref="bodyRef" @scroll="onBodyScroll">
      <template v-if="activeTab === 'outline'">
        <div v-if="status === 'no-source'" class="empty">{{ t('outline.empty') }}</div>
        <div v-else-if="status === 'untitled'" class="empty">{{ t('outline.untitled') }}</div>
        <div v-else-if="status === 'too-large'" class="empty">{{ t('outline.tooLarge') }}</div>
        <div v-else-if="status === 'unsupported'" class="empty">{{ t('outline.unsupported') }}</div>
        <div v-else-if="status === 'empty'" class="empty">{{ t('outline.noSymbols') }}</div>
        <OutlineTreeView v-else :nodes="nodes" @select="onSelect" />
      </template>
      <div v-else class="empty">—</div>
    </div>
  </div>
</template>

<style scoped>
.outline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: -12px;
}

.outline-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.outline-tab {
  flex: 1;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.outline-tab:hover:not(:disabled) {
  color: var(--text-primary);
}

.outline-tab.active {
  color: var(--text-active);
  border-bottom-color: var(--accent);
}

.outline-tab:disabled {
  opacity: 0.4;
  cursor: default;
}

.outline-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 4px;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 6px 8px;
}
</style>
