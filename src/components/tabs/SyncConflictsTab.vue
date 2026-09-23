<script setup lang="ts">
/**
 * 設定の同期の衝突を解消するタブ（#403）。手元とリモートの両方が、前回同期した時点から別の
 * 値に変えた項目を並べ、どちらを採るかを選ばせる。
 *
 * **中身は同期の調停役（`stores/sync.ts`）が持つ。** 選んだら、その選択を持ってもう一度
 * 同期する（読み直してマージし直すので、選んでいるあいだにリモートが変わっても古い値で
 * 上書きしない）。選ばなかった項目は保留のまま残る。
 *
 * **インポート（`sync-import`、段階 5）も同じ画面で描く。** こちらは「手元」と「取り込む
 * ファイル」を並べ、ファイルの側を選んだ項目だけを取り込む（選ばなかった項目は手元のまま）。
 * 保留は無いので、当てたら一覧は閉じる。
 */

import { FileInput, GitMerge, RefreshCw } from 'lucide-vue-next'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { absoluteDate } from '../../lib/paths'
import { parseItemKey, SYNC_CATEGORIES } from '../../lib/syncFormat'
import type { Side } from '../../lib/syncMerge'
import { describeError, importChosenCount, type SyncConflictView, useSyncStore } from '../../stores/sync'
import { useTabStore } from '../../stores/tabs'
import HelpButton from '../HelpButton.vue'

const props = defineProps<{ tabId: string }>()

const { t } = useI18n()
const sync = useSyncStore()
const tabStore = useTabStore()
/** タブの種別は作ったあと変わらないので、1 度だけ読む。 */
const isImport = tabStore.tabs.find((x) => x.id === props.tabId)?.kind === 'sync-import'

/** 画面の文言（i18n のキー）。2 つの画面の違いをここに集め、テンプレートでは分岐しない。 */
const TEXT = isImport
  ? {
      title: 'sync.importTitle',
      help: 'settings.md#エクスポートとインポート',
      allLocal: 'sync.importNone',
      allRemote: 'sync.importAll',
      chosen: 'sync.importChosen',
      apply: 'sync.importApply',
      remote: 'sync.importFile',
    }
  : {
      title: 'sync.conflictsTitle',
      help: 'settings.md#設定の同期',
      allLocal: 'sync.allLocal',
      allRemote: 'sync.allRemote',
      chosen: 'sync.chosen',
      apply: 'sync.apply',
      remote: 'sync.remote',
    }
const hint = computed(() =>
  isImport ? 'sync.importHint' : sync.firstSync ? 'sync.firstSyncHint' : 'sync.conflictsHint',
)

/** インポートのファイルを読む・当てるあいだ（同期と違ってストアに印が無い）。 */
const importing = ref(false)
const importError = ref('')
const busy = computed(() => (isImport ? importing.value : sync.syncing))
const error = computed(() =>
  isImport ? importError.value : sync.status === 'error' ? t('sync.error', { message: sync.message }) : '',
)

/** 並べる項目。インポートは読んだファイルとの差、同期は保留中の衝突。 */
const items = computed(() => (isImport ? (sync.importReview?.items ?? []) : sync.conflicts))

/**
 * 項目ごとの選択。同期の衝突は、一覧が変わっても今も残っている項目のぶんを持ち越す（同じ
 * 項目の同じ対立）。**インポートは読み直したら捨てる**: 同じキーでも値は別のファイルのもので、
 * 見ていない値を取り込むことになる。
 */
const choices = ref(new Map<string, Side>())
watch(items, (list) => {
  const keys = new Set(list.map((c) => c.key))
  choices.value = isImport ? new Map() : new Map([...choices.value].filter(([k]) => keys.has(k)))
})

// 読んだ差はタブを閉じたら要らない（ストアに残すと、開き直したときに古い一覧が出る）。
onUnmounted(() => {
  if (isImport) sync.cancelImport()
})

async function runImport(run: () => Promise<unknown>) {
  importing.value = true
  importError.value = ''
  try {
    await run()
  } catch (e) {
    importError.value = describeError(e)
  } finally {
    importing.value = false
  }
}

function choose(key: string, side: Side) {
  const next = new Map(choices.value)
  next.set(key, side)
  choices.value = next
}

function chooseAll(side: Side) {
  choices.value = new Map(items.value.map((c) => [c.key, side]))
}

function apply() {
  if (isImport) void runImport(() => sync.applyImport(choices.value))
  else sync.resolveConflicts(choices.value)
}

/** プロジェクトのフィールドの名前（`sync.field.<名前>`）。訳が無ければフィールド名のまま。 */
function fieldLabel(field: string): string {
  const key = `sync.field.${field}`
  const s = t(key)
  return s === key ? field : s
}

/** 項目の名前。設定はキーをそのまま出す（どの設定かを探すときに検索できる）。 */
function label(c: SyncConflictView): string {
  const k = parseItemKey(c.key)
  switch (k[0]) {
    case 'setting':
      return k[1]
    case 'project':
      if (k.length === 2) return t('sync.item.project', { name: c.projectName ?? k[1] })
      return `${c.projectName ?? k[1]} › ${fieldLabel(k[2])}`
    case 'group':
      return t('sync.item.group', { name: k[1] })
    case 'order':
      return k[1] === 'groups'
        ? t('sync.item.groupOrder')
        : t('sync.item.projectOrder', { group: k[2] || t('sync.ungrouped') })
  }
}

/** 値の見せ方。「無い」は削除として、プロジェクトの有無は言葉で出す。 */
function show(c: SyncConflictView, v: unknown): string {
  if (v === undefined) return t('sync.value.absent')
  const k = parseItemKey(c.key)
  if (k[0] === 'project' && k.length === 2) return t('sync.value.projectKept')
  if (typeof v === 'string') return v
  return JSON.stringify(v, null, 2)
}

/**
 * 表示する行。**名前と値の文字列はここで 1 度だけ作る**: テンプレートで組むと、側を押す
 * たび（`choices` が変わるたび）に全行の値を `JSON.stringify` し直す。初めての同期では
 * 行が百を超え、サイトのルールの JS のような長い値も並ぶ。
 */
const groups = computed(() =>
  SYNC_CATEGORIES.map((category) => ({
    category,
    rows: items.value
      .filter((c) => c.category === category)
      .map((c) => ({ key: c.key, label: label(c), local: show(c, c.local), remote: show(c, c.remote) })),
  })).filter((g) => g.rows.length > 0),
)

const chosenCount = computed(() => (isImport ? importChosenCount(choices.value) : choices.value.size))
</script>

<template>
  <div class="sync-conflicts">
    <header class="head">
      <h1>
        <FileInput v-if="isImport" :size="16" :stroke-width="2" />
        <GitMerge v-else :size="16" :stroke-width="2" />
        <span>{{ t(TEXT.title) }}</span>
      </h1>
      <div class="head-actions">
        <button v-if="isImport" class="btn" :disabled="busy" @click="runImport(sync.chooseImportFile)">
          <RefreshCw v-if="busy" :size="13" :stroke-width="2" class="spin" />
          <FileInput v-else :size="13" :stroke-width="2" />
          <span>{{ t('sync.importChoose') }}</span>
        </button>
        <button v-else class="btn" :disabled="busy" @click="sync.syncNow()">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: busy }" />
          <span>{{ t('sync.syncNow') }}</span>
        </button>
        <HelpButton :page="TEXT.help" :size="15" />
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="isImport && sync.importReview" class="hint">{{ t('sync.importFrom', { path: sync.importReview.path }) }}</p>

    <template v-if="items.length > 0">
      <p class="hint">{{ t(hint) }}</p>
      <div class="bulk">
        <button class="btn" :disabled="busy" @click="chooseAll('local')">{{ t(TEXT.allLocal) }}</button>
        <button class="btn" :disabled="busy" @click="chooseAll('remote')">{{ t(TEXT.allRemote) }}</button>
        <span class="spacer" />
        <span class="muted">{{ t(TEXT.chosen, { chosen: chosenCount, total: items.length }) }}</span>
        <button class="accent-btn" :disabled="busy || chosenCount === 0" @click="apply">{{ t(TEXT.apply) }}</button>
      </div>

      <section v-for="g in groups" :key="g.category" class="group">
        <h2>{{ t(`sync.category.${g.category}`) }}</h2>
        <div v-for="row in g.rows" :key="row.key" class="row">
          <div class="row-label">{{ row.label }}</div>
          <div class="sides">
            <button
              v-for="side in ['local', 'remote'] as const"
              :key="side"
              class="side"
              :class="{ chosen: choices.get(row.key) === side }"
              :disabled="busy"
              @click="choose(row.key, side)"
            >
              <span class="side-head">{{ t(side === 'local' ? 'sync.local' : TEXT.remote) }}</span>
              <pre class="value">{{ row[side] }}</pre>
            </button>
          </div>
        </div>
      </section>
    </template>

    <p v-else-if="isImport" class="empty">
      {{ sync.importMessage || t(sync.importReview ? 'sync.importNoDiff' : 'sync.importEmpty') }}
    </p>
    <p v-else class="empty">
      {{ t('sync.noConflicts') }}
      <template v-if="sync.lastSyncedAt">
        {{ t('sync.lastSynced', { at: absoluteDate(sync.lastSyncedAt) }) }}
      </template>
    </p>
  </div>
</template>

<style scoped>
.sync-conflicts {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px 24px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.head h1 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-active);
}

.head-actions,
.bulk {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bulk {
  max-width: 960px;
  margin-bottom: 14px;
}

.spacer {
  flex: 1;
}

.btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  color: var(--text-active);
}

.btn:disabled,
.accent-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.accent-btn {
  padding: 3px 12px;
  font-size: 12px;
}

.hint,
.empty,
.muted {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.hint {
  max-width: 960px;
  margin: 0 0 10px;
}

.error {
  font-size: 12px;
  color: var(--danger);
}

.group {
  max-width: 960px;
  margin-bottom: 16px;
}

.group h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-active);
}

.row {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px 10px;
  margin-bottom: 8px;
  background: var(--bg-secondary);
}

.row-label {
  margin-bottom: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text-active);
}

.sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  text-align: left;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.side:hover:not(:disabled) {
  border-color: var(--accent);
}

.side.chosen {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.side-head {
  font-size: 11px;
  color: var(--text-secondary);
}

.side.chosen .side-head {
  color: var(--accent);
  font-weight: 600;
}

/* 起動行やルールの JS のような長い値も読めるよう、折り返して高さで頭打ちにする。 */
.value {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
