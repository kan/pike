<script setup lang="ts">
/**
 * ブラウザパネル（#368）。新しいタブのボタン、ブックマーク、閲覧履歴の 3 つを置く。
 *
 * **ブックマークは設定のストア、閲覧履歴は `stores/browser.ts`** にある。前者は同期の
 * 対象で、後者はマシンごと（理由はそれぞれの宣言の隣）。
 *
 * 絞り込みは 2 つの欄に同時に効く。ブックマークの並べ替え（ドラッグ）は、絞り込んで
 * いないときだけ受ける（見えている並びと実際の並びが食い違うため。プロジェクト一覧と同じ）。
 */

import { History, Plus, Search, Star, Trash2, X } from 'lucide-vue-next'
import { computed, ref, useTemplateRef } from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { confirmDialog, promptDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { displayHost } from '../../lib/format'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { fuzzyMatch, relativeDate } from '../../lib/paths'
import { sideOf } from '../../lib/reorder'
import { useBrowserStore } from '../../stores/browser'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'

const { t } = useI18n()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()
const browserStore = useBrowserStore()

const filter = ref('')

/** URL 欄が空のブラウザのタブを開く。URL はタブのアドレス欄で打つ。 */
function openBlank() {
  tabStore.addBrowserTab('')
}

function open(url: string) {
  tabStore.addBrowserTab(url)
}

const query = computed(() => filter.value.trim())

function matches(...texts: string[]): boolean {
  return !query.value || texts.some((s) => fuzzyMatch(s, query.value))
}

const bookmarks = computed(() =>
  settingsStore.browserBookmarks.filter((b) => matches(b.name, b.url)).map((b) => ({ ...b, host: displayHost(b.url) })),
)
const history = computed(() =>
  browserStore.history
    .filter((v) => matches(v.title, v.url))
    .map((v) => ({ ...v, host: displayHost(v.url), since: relativeDate(v.at) })),
)

// --- ブックマークの並べ替え ---
const dragging = ref<string | null>(null)
const dropTarget = ref<{ url: string; side: 'top' | 'bottom' } | null>(null)
// `draggable` がこれで切り替わるので、絞り込み中は `dragstart` 自体が起きない。
const canReorder = computed(() => !query.value)

function onDragStart(url: string) {
  dragging.value = url
}

function onDragOver(e: DragEvent, url: string) {
  if (!dragging.value || dragging.value === url) return
  e.preventDefault()
  dropTarget.value = { url, side: sideOf(e) }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (dragging.value && dropTarget.value) {
    settingsStore.moveBookmark(dragging.value, dropTarget.value.url, dropTarget.value.side)
  }
  onDragEnd()
}

function onDragEnd() {
  dragging.value = null
  dropTarget.value = null
}

// --- 右クリックメニュー（器は `theme.css` の `.panel-ctx-menu`） ---
/** 右クリックした行。`name` はブックマークなら名前、履歴ならページのタイトル。 */
type CtxTarget = { kind: 'bookmark' | 'history'; url: string; name: string }
const ctx = ref<CtxTarget | null>(null)
const { style: ctxStyle, placeAt: placeCtx, reset: resetCtx } = useAnchoredPopup(useTemplateRef<HTMLElement>('ctxEl'))

async function openCtx(e: MouseEvent, target: CtxTarget) {
  e.preventDefault()
  ctx.value = target
  resetCtx()
  await placeCtx({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeCtx, { once: true })
}

function closeCtx() {
  ctx.value = null
  resetCtx()
}

/** 項目は「閉じてから実行」で揃える（issue パネルと同じ）。 */
function runCtx(fn: (target: CtxTarget) => unknown) {
  const target = ctx.value
  closeCtx()
  if (target) void fn(target)
}

async function renameBookmark(target: CtxTarget) {
  const name = await promptDialog(t('browser.renamePrompt'), target.name)
  if (name !== null) settingsStore.renameBookmark(target.url, name)
}

async function clearHistory() {
  if (await confirmDialog(t('browser.clearHistoryConfirm'))) browserStore.clearHistory()
}
</script>

<template>
  <div class="browser-panel">
    <button class="new-tab-btn" @click="openBlank">
      <Plus :size="13" :stroke-width="2" />
      <span>{{ t('browser.newTab') }}</span>
    </button>
    <!-- 見た目は `theme.css` の `.filter-row`（プロジェクトパネルの絞り込みと共有）。 -->
    <div class="filter-row panel-row">
      <Search :size="12" :stroke-width="2" class="filter-icon" />
      <input
        v-model="filter"
        class="filter-input"
        spellcheck="false"
        :placeholder="t('browser.filterPlaceholder')"
        @keydown.escape.prevent="filter = ''"
      />
    </div>

    <div class="section-header">
      <Star :size="12" :stroke-width="2" />
      <span>{{ t('browser.bookmarks') }}</span>
    </div>
    <div v-if="bookmarks.length === 0" class="empty">
      {{ t(settingsStore.browserBookmarks.length ? 'browser.noMatch' : 'browser.noBookmarks') }}
    </div>
    <div
      v-for="b in bookmarks"
      :key="b.url"
      class="browser-item"
      :class="dropTarget?.url === b.url && `drop-${dropTarget.side}`"
      :title="b.url"
      :draggable="canReorder"
      @click="open(b.url)"
      @contextmenu="openCtx($event, { kind: 'bookmark', url: b.url, name: b.name })"
      @dragstart="onDragStart(b.url)"
      @dragover="onDragOver($event, b.url)"
      @drop="onDrop"
      @dragend="onDragEnd"
    >
      <span class="item-title">{{ b.name }}</span>
      <span class="item-meta">{{ b.host }}</span>
      <button class="row-action" :title="t('browser.removeBookmark')" @click.stop="settingsStore.removeBookmark(b.url)">
        <X :size="13" :stroke-width="2" />
      </button>
    </div>

    <div class="section-header">
      <History :size="12" :stroke-width="2" />
      <span>{{ t('browser.history') }}</span>
      <button
        v-if="browserStore.history.length"
        class="header-action"
        :title="t('browser.clearHistory')"
        @click="clearHistory"
      >
        <Trash2 :size="12" :stroke-width="2" />
      </button>
    </div>
    <div v-if="history.length === 0" class="empty">
      {{ t(browserStore.history.length ? 'browser.noMatch' : 'browser.noHistory') }}
    </div>
    <div
      v-for="v in history"
      :key="v.url"
      class="browser-item"
      :title="v.url"
      @click="open(v.url)"
      @contextmenu="openCtx($event, { kind: 'history', url: v.url, name: v.title })"
    >
      <span class="item-title">{{ v.title }}</span>
      <span class="item-meta">{{ v.host }} · {{ v.since }}</span>
      <button class="row-action" :title="t('browser.removeVisit')" @click.stop="browserStore.removeVisit(v.url)">
        <X :size="13" :stroke-width="2" />
      </button>
    </div>

    <Teleport to="body">
      <div v-if="ctx" ref="ctxEl" class="panel-ctx-menu popup-surface" :style="ctxStyle" @mousedown.stop>
        <button @click="runCtx((c) => open(c.url))">{{ t('browser.openTab') }}</button>
        <!-- ブラウザへ出るので確認を挟む（外部 URL を開く規約、#311）。 -->
        <button @click="runCtx((c) => openUrlWithConfirm(c.url))">{{ t('browser.openExternal') }}</button>
        <div class="ctx-separator"></div>
        <template v-if="ctx.kind === 'bookmark'">
          <button @click="runCtx(renameBookmark)">{{ t('browser.renameBookmark') }}</button>
          <button @click="runCtx((c) => settingsStore.removeBookmark(c.url))">{{ t('browser.removeBookmark') }}</button>
        </template>
        <template v-else>
          <button
            v-if="!settingsStore.isBookmarked(ctx.url)"
            @click="runCtx((c) => settingsStore.addBookmark(c.url, c.name))"
          >
            {{ t('browser.addBookmark') }}
          </button>
          <button @click="runCtx((c) => browserStore.removeVisit(c.url))">{{ t('browser.removeVisit') }}</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.browser-panel {
  padding: 4px 0;
  overflow-y: auto;
  height: 100%;
}

.new-tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: calc(100% - 16px);
  margin: 4px 8px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.new-tab-btn:hover {
  border-color: var(--accent);
}

/* 共有の `.filter-row` に、パネルの中での余白だけを足す。 */
.panel-row {
  margin: 4px 8px 2px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 12px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.header-action {
  margin-left: auto;
  display: flex;
  align-items: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.header-action:hover {
  color: var(--text-active);
  background: var(--bg-tertiary);
}

.empty {
  padding: 6px 12px;
  color: var(--text-secondary);
  font-size: 12px;
}

.browser-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.browser-item:hover {
  background: var(--bg-tertiary);
}

.browser-item:hover .row-action {
  opacity: 1;
}

/* ドロップ位置の印（プロジェクト一覧と同じ見た目）。 */
.browser-item.drop-top {
  box-shadow: inset 0 2px 0 var(--accent);
}

.browser-item.drop-bottom {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-meta {
  flex-shrink: 1;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 11px;
}
</style>
