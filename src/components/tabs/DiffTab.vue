<script setup lang="ts">
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { parseDiff } from '../../lib/diffParser'
import { collectMatches, renderTokens } from '../../lib/diffSearch'
import { useTabStore } from '../../stores/tabs'
import type { DiffTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()

const tab = computed(() => tabStore.tabs.find((t): t is DiffTab => t.id === props.tabId && t.kind === 'diff'))

const parsedLines = computed(() => (tab.value ? parseDiff(tab.value.diff, { charLevel: true }) : []))

// --- Search (#176) -------------------------------------------------------
const showSearch = ref(false)
const query = ref('')
const caseSensitive = ref(false)
const currentIndex = ref(0)
const searchInput = ref<HTMLInputElement>()
const scrollEl = ref<HTMLElement>()

const matches = computed(() => collectMatches(parsedLines.value, query.value, caseSensitive.value))

// Cell-local match ranges keyed by `${row}:${side}`, carrying each match's
// global index so the renderer and navigation agree on which match is current.
const cellRanges = computed(() => {
  const map = new Map<string, { start: number; end: number; index: number }[]>()
  matches.value.forEach((m, index) => {
    const key = `${m.row}:${m.side}`
    const list = map.get(key)
    const range = { start: m.start, end: m.end, index }
    if (list) list.push(range)
    else map.set(key, [range])
  })
  return map
})

// One entry per row, each a [left, right] pair of cells. Tokens don't depend on
// currentIndex — the active match is styled from the token's matchIndex in the
// template, so navigation doesn't re-tokenize.
const rows = computed(() =>
  parsedLines.value.map((line, row) =>
    (['left', 'right'] as const).map((side) => ({
      type: line[side].type,
      num: line[side].num,
      tokens: renderTokens(line[side].segments, cellRanges.value.get(`${row}:${side}`) ?? []),
    })),
  ),
)

const matchInfo = computed(() => {
  if (!query.value) return ''
  if (matches.value.length === 0) return t('search.noResults')
  return `${currentIndex.value + 1} / ${matches.value.length}`
})

function scrollToCurrent() {
  nextTick(() => {
    scrollEl.value?.querySelector(`[data-match="${currentIndex.value}"]`)?.scrollIntoView({ block: 'center' })
  })
}

function step(delta: number) {
  const n = matches.value.length
  if (n === 0) return
  currentIndex.value = (currentIndex.value + delta + n) % n
  scrollToCurrent()
}

function openSearch() {
  showSearch.value = true
  nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}

function closeSearch() {
  showSearch.value = false
}

// Reset to the first match whenever the query or case mode changes.
watch([query, caseSensitive], () => {
  currentIndex.value = 0
  if (matches.value.length > 0) scrollToCurrent()
})

// A rebuilt diff can shrink the match list under the cursor.
watch(matches, (m) => {
  if (currentIndex.value >= m.length) currentIndex.value = 0
})

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
}

// Tabs stay mounted (v-show), so only react to Ctrl+F when this diff tab is the
// active one — otherwise every mounted DiffTab would grab the shortcut.
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    if (tabStore.activeTabId !== props.tabId) return
    e.preventDefault()
    openSearch()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="diff-tab">
    <div v-if="!tab" class="empty">{{ t('diff.notFound') }}</div>
    <div v-else-if="!parsedLines.length && tab.diff" class="empty">
      {{ tab.diff.includes('Binary files') ? t('diff.binary') : tab.diff.slice(0, 200) }}
    </div>
    <div v-else-if="!parsedLines.length" class="empty">{{ t('diff.noChanges') }}</div>
    <template v-else>
      <div ref="scrollEl" class="diff-scroll">
        <table class="diff-table">
          <tbody>
            <tr v-for="(row, i) in rows" :key="i" class="diff-row">
              <template v-for="(cell, s) in row" :key="s">
                <td class="line-num" :class="cell.type">{{ cell.num ?? "" }}</td>
                <td class="line-content" :class="cell.type"><template
                  v-for="(tok, j) in cell.tokens" :key="j"
                ><span :class="{ 'hl': tok.diffHl, 'search-hl': tok.matchIndex >= 0, 'search-current': tok.matchIndex === currentIndex }" :data-match="tok.matchIndex >= 0 ? tok.matchIndex : undefined">{{ tok.text }}</span></template></td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="showSearch" class="diff-search popup-surface">
        <input
          ref="searchInput"
          v-model="query"
          class="search-field"
          type="text"
          spellcheck="false"
          :placeholder="t('search.placeholder')"
          @keydown="onSearchKeydown"
        />
        <button
          class="search-toggle-btn"
          :class="{ active: caseSensitive }"
          :title="t('search.matchCase')"
          @click="caseSensitive = !caseSensitive"
        >
          <CaseSensitive :size="14" :stroke-width="2" />
        </button>
        <span class="search-match-info">{{ matchInfo }}</span>
        <button class="search-icon-btn" :title="t('search.prevMatch')" @click="step(-1)"><ChevronUp :size="14" :stroke-width="2" /></button>
        <button class="search-icon-btn" :title="t('search.nextMatch')" @click="step(1)"><ChevronDown :size="14" :stroke-width="2" /></button>
        <button class="search-icon-btn" :title="t('search.close')" @click="closeSearch"><X :size="14" :stroke-width="2" /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-tab {
  position: absolute;
  inset: 0;
  background: var(--bg-primary);
}

.diff-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
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

.search-hl {
  background: rgba(255, 200, 0, 0.35);
  border-radius: 2px;
}

.search-current {
  background: rgba(255, 160, 0, 0.85);
  color: #1a1a1a;
  border-radius: 2px;
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

/* Floating search panel (mirrors the editor's search look) */
.diff-search {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.search-field {
  width: 180px;
  padding: 3px 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.search-field:focus {
  border-color: var(--accent);
}

.search-match-info {
  min-width: 56px;
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}

.search-icon-btn,
.search-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.search-icon-btn:hover,
.search-toggle-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.search-toggle-btn.active {
  background: var(--accent);
  color: #fff;
}
</style>
