<script setup lang="ts">
/**
 * Redis ビューワ（#647）のタブ。つなげた接続先（`tab.target`）について、キーを選び、値を型に合わせて見る
 * （string は本文、list / hash / set / zset / stream は表）。**読むだけで、書き込むコマンドは送らない。**
 *
 * 接続のフォームは持たない（DB タブと同じく、接続先を選ぶのは DB パネル、入力するのは接続のダイアログ。
 * `stores/db.ts` の `open`）。表は CSV プレビューの部品（`useCsvTable`）。コマンドは Rust（`db/redis.rs`）の
 * 固定のもので、ここから渡せるのは接続先・パターン・キーの名前だけ。判断の記録は `.claude/rules/db.md`。
 */
import { Copy, RefreshCw, Save } from 'lucide-vue-next'
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useCsvTable } from '../../composables/useCsvTable'
import { useI18n } from '../../i18n'
import { dbErrorText, dbResultToCsv, ENGINE_LABELS, formatDbResult } from '../../lib/dbViewer'
import { hostDefaultShell } from '../../lib/host'
import { fsWriteFile, pickSaveFile, redisKeys, redisProbe, redisValue } from '../../lib/tauri'
import { useDbStore } from '../../stores/db'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { DbDumpFormat, DbTarget, RedisDatabase, RedisKey, RedisKeyList, RedisValue } from '../../types/db'
import type { DbTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const db = useDbStore()
const statusMessageStore = useStatusMessageStore()

const tab = computed(() => tabStore.tabs.find((x): x is DbTab => x.id === props.tabId && x.kind === 'db'))
const target = computed(() => tab.value?.target)

const databases = ref<RedisDatabase[]>([])
const currentDatabase = ref(0)
/** 最大 5,000 件を丸ごと差し替えるだけなので、深いリアクティブにしない。 */
const keys = shallowRef<RedisKey[]>([])
const keysTruncated = ref(false)
/** `SCAN` の `MATCH` に渡すパターン（Enter で読み直す）。空なら全部。 */
const pattern = ref('')
const selectedKey = shallowRef<RedisKey | null>(null)

/**
 * キーの同一性。バイナリの名前はバイト列（`raw`）、ほかは名前で見る。見せる名前だけで比べると、
 * 文字どおり `a\xff` という名前のキーと、`a` と 0xff のバイナリのキーが同じに見える。
 */
function keyId(k: RedisKey): string {
  return k.raw !== null ? `x:${k.raw}` : `s:${k.name}`
}

const selectedId = computed(() => (selectedKey.value ? keyId(selectedKey.value) : null))
/** 値は丸ごと差し替えるだけなので、深いリアクティブにしない（最大 2,000 行 × 列）。 */
const value = shallowRef<RedisValue | null>(null)
const loadingKeys = ref(false)
const loadingValue = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const format = ref<DbDumpFormat>('csv')

const patternInput = useTemplateRef<HTMLInputElement>('patternInput')

/** 応答の取り違えを防ぐ番号（キーを続けて選んだとき、遅れて届いた古い値を捨てる）。 */
let keySeq = 0
let valueSeq = 0

/**
 * キーの一覧を読む共通の手順。`fetch` の結果は、そのあいだに次の読み込みが始まっていなければ `apply` へ渡す
 * （遅れて届いた古い一覧で上書きしない）。
 */
async function fetchKeys<T>(to: DbTarget, fetch: () => Promise<T>, apply: (r: T) => RedisKeyList) {
  const my = ++keySeq
  loadingKeys.value = true
  error.value = null
  try {
    const r = await fetch()
    if (my !== keySeq) return
    const list = apply(r)
    keys.value = list.keys
    keysTruncated.value = list.truncated
  } catch (e) {
    if (my === keySeq) error.value = dbErrorText(e, to)
  } finally {
    if (my === keySeq) loadingKeys.value = false
  }
}

/** 接続先の DB の一覧とキーの一覧を読む。開いた直後はストアがつないだときに読んだものを使う。 */
function loadAll(to: DbTarget) {
  valueSeq++
  selectedKey.value = null
  value.value = null
  pattern.value = ''
  const pre = db.takeRedisPrefetched(props.tabId)
  return fetchKeys(
    to,
    () => (pre ? Promise.resolve(pre) : redisProbe(to)),
    (p) => {
      databases.value = p.databases
      currentDatabase.value = p.current
      void nextTick(() => patternInput.value?.focus())
      return p.keys
    },
  )
}

// 開いたときと、接続先を差し替えたとき（「接続先を変える」・DB の切り替え）に読み直す。
watch(target, (to) => to && void loadAll(to), { immediate: true })

/** パターンでキーの一覧を読み直す（Enter・更新ボタン）。選んでいるキーは、一覧に残っていれば残す。 */
function reloadKeys() {
  const to = target.value
  if (!to) return
  return fetchKeys(
    to,
    // 前後の空白もキーの一部なので削らない（空なら全部は Rust が決める）。
    () => redisKeys(to, pattern.value),
    (list) => {
      if (selectedId.value && !list.keys.some((k) => keyId(k) === selectedId.value)) {
        selectedKey.value = null
      }
      return list
    },
  )
}

/** DB を切り替える。DB タブと同じく、つないで確かめてからこのタブの接続先を差し替える。 */
async function switchDatabase(select: HTMLSelectElement) {
  const tb = tab.value
  if (!tb) return
  const ok = await db.open({ ...tb.target, database: select.value }, { tabId: tb.id, save: false })
  if (!ok) select.value = String(currentDatabase.value)
}

async function loadValue() {
  const to = target.value
  const key = selectedKey.value
  if (!to || key === null) return
  const my = ++valueSeq
  loadingValue.value = true
  error.value = null
  try {
    const v = await redisValue(to, key)
    if (my !== valueSeq) return
    value.value = v
  } catch (e) {
    if (my !== valueSeq) return
    value.value = null
    error.value = dbErrorText(e, to)
  } finally {
    if (my === valueSeq) loadingValue.value = false
  }
}

// --- 表（CSV プレビューの部品） ---

const tableRef = ref<HTMLElement>()
const csvData = computed(() => (value.value?.result ? dbResultToCsv(value.value.result) : null))
const csvTable = useCsvTable({ container: tableRef, data: () => csvData.value })
const tableHtml = csvTable.html

// 別のキーに移ったら読み直し、並べ替えと選択を初めに戻す（別の表の列番号で並べない）。
watch(selectedId, () => {
  csvTable.selection.clear()
  csvTable.setSort(null)
  // 読みかけの値は捨てる（選択を外したときも。`loadValue` はキーが無ければ番号を進めずに戻るので、
  // ここで進めないと、外す前のキーの値が遅れて届いて表に出る）。
  valueSeq++
  loadingValue.value = false
  value.value = null
  void loadValue()
})

function copyText(text: string, message: string) {
  navigator.clipboard.writeText(text).then(
    () => statusMessageStore.show({ text: message, variant: 'success' }),
    (e) => statusMessageStore.show({ text: String(e), variant: 'error' }),
  )
}

function onTableKeydown(e: KeyboardEvent) {
  csvTable.handleKeydown(e, (text) => copyText(text, t('csv.copied')))
}

/** コピーと保存ができる値か（string か表）。 */
const exportable = computed(() => !!value.value && (value.value.text !== null || !!value.value.result))

/**
 * 表示している値の、コピーと保存の中身（string は本文、ほかは CSV / TSV）。最大 2,000 行を整形するので、
 * 押したときにだけ作る。
 */
function exported() {
  const v = value.value
  if (!v) return null
  if (v.text !== null) return { text: v.text, ext: 'txt', count: null }
  if (v.result) return { text: formatDbResult(v.result, format.value), ext: format.value, count: v.result.rows.length }
  return null
}

function copyValue() {
  const x = exported()
  if (!x) return
  copyText(x.text, x.count === null ? t('redis.copiedText') : t('db.copied', { count: x.count.toLocaleString() }))
}

/** 表示している値をファイルに書き出す（読んだ先頭だけ。全体の書き出しは持たない）。 */
async function saveValue() {
  const x = exported()
  const key = selectedKey.value
  if (!x || key === null) return
  // キーには `:` や `/` がよく入るので、ファイル名に使えない文字は `_` にする。
  const name = key.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'value'
  const path = await pickSaveFile(`${name}.${x.ext}`).catch(() => null)
  if (!path) return
  saving.value = true
  try {
    await fsWriteFile(hostDefaultShell(), path, x.ext === 'txt' ? x.text : `${x.text}\n`)
    statusMessageStore.show({ text: t('redis.saved', { path }), variant: 'success' })
  } catch (e) {
    statusMessageStore.show({ text: String(e), variant: 'error' })
  } finally {
    saving.value = false
  }
}

/** キーの残りの時間の表示（期限が無ければ「期限なし」、`TTL` が読めなければ「期限は不明」）。 */
const ttlText = computed(() => {
  const ttl = value.value?.ttl
  if (ttl === null || ttl === undefined) return t('redis.ttlUnknown')
  return ttl < 0 ? t('redis.noExpiry') : t('redis.ttl', { seconds: ttl.toLocaleString() })
})

/** DB の選択肢の文言（キーの数が分からなければ番号だけ）。 */
function databaseLabel(d: RedisDatabase): string {
  return d.keys === null
    ? t('redis.databaseOptionUnknown', { index: d.index })
    : t('redis.databaseOption', { index: d.index, count: d.keys.toLocaleString() })
}

const lengthText = computed(() => {
  const v = value.value
  if (!v || v.length === null) return ''
  return v.kind === 'string'
    ? t('redis.bytes', { count: v.length.toLocaleString() })
    : t('redis.items', { count: v.length.toLocaleString() })
})

/** 先頭だけを見せているときの帯。 */
const truncatedText = computed(() => {
  const v = value.value
  if (!v?.truncated) return null
  return v.text !== null
    ? t('redis.truncatedText')
    : t('redis.truncatedItems', { shown: (v.result?.rows.length ?? 0).toLocaleString() })
})

const connectedLabel = computed(() => {
  const tb = tab.value
  return tb ? `${ENGINE_LABELS[tb.target.engine]} · ${tb.title}` : ''
})

/** 「接続先を変える」。今の接続先で埋めたダイアログを出し、つなげたらこのタブを差し替える。 */
function changeConnection() {
  const tb = tab.value
  if (tb) db.openDialog(tb.target, { tabId: tb.id })
}
</script>

<template>
  <div class="redis-tab">
    <div class="redis-body">
      <aside class="redis-side">
        <div class="redis-side-head">
          <span class="redis-conn" :title="connectedLabel">{{ connectedLabel }}</span>
          <button type="button" class="redis-link" @click="changeConnection">{{ t('db.changeConnection') }}</button>
        </div>
        <select
          v-if="databases.length"
          class="redis-db"
          :value="String(currentDatabase)"
          :title="t('db.redisDatabase')"
          @change="switchDatabase($event.target as HTMLSelectElement)"
        >
          <option v-for="d in databases" :key="d.index" :value="String(d.index)">
            {{ databaseLabel(d) }}
          </option>
        </select>
        <input
          ref="patternInput"
          v-model="pattern"
          class="redis-filter"
          type="text"
          spellcheck="false"
          :placeholder="t('redis.pattern')"
          :title="t('redis.patternHint')"
          @keydown.enter="reloadKeys"
        />
        <div v-if="keysTruncated" class="redis-hint">{{ t('redis.keysTruncated') }}</div>
        <div class="redis-key-list">
          <button
            v-for="k in keys"
            :key="keyId(k)"
            v-memo="[k, keyId(k) === selectedId]"
            type="button"
            class="redis-key-item"
            :class="{ selected: keyId(k) === selectedId }"
            :title="k.name"
            @click="selectedKey = k"
          >
            <span class="redis-key-name">{{ k.name }}</span>
            <span class="redis-key-kind">{{ k.kind }}</span>
          </button>
          <div v-if="!keys.length && !loadingKeys" class="redis-hint">{{ t('redis.noKeys') }}</div>
        </div>
      </aside>

      <section class="redis-main">
        <div class="redis-toolbar">
          <span class="redis-current selectable">{{ selectedKey?.name ?? '' }}</span>
          <button type="button" :title="t('common.refresh')" :disabled="loadingKeys" @click="selectedKey ? loadValue() : reloadKeys()">
            <RefreshCw :size="13" :stroke-width="2" />
          </button>
          <select v-if="value?.result" v-model="format" :title="t('db.format')">
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
          </select>
          <button type="button" :title="t('redis.copyHint')" :disabled="!exportable || loadingValue" @click="copyValue">
            <Copy :size="13" :stroke-width="2" /><span>{{ t('db.copy') }}</span>
          </button>
          <button
            type="button"
            :title="t('redis.saveHint')"
            :disabled="!exportable || loadingValue || saving"
            @click="saveValue"
          >
            <Save :size="13" :stroke-width="2" /><span>{{ saving ? t('db.saving') : t('db.save') }}</span>
          </button>
        </div>
        <div v-if="value" class="redis-meta">
          <span class="redis-kind">{{ value.kind }}</span>
          <span v-if="lengthText">{{ lengthText }}</span>
          <span>{{ ttlText }}</span>
        </div>
        <div v-if="truncatedText" class="redis-banner">{{ truncatedText }}</div>
        <div v-if="value?.binary" class="redis-banner">{{ t('redis.binaryValue') }}</div>
        <div v-if="error" class="redis-error selectable">{{ error }}</div>
        <div v-else-if="(loadingValue && !value) || (loadingKeys && !keys.length)" class="redis-hint redis-pad">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="selectedKey === null" class="redis-hint redis-pad">{{ t('redis.pickKey') }}</div>
        <template v-else-if="value">
          <pre v-if="value.text !== null" class="redis-text selectable" :class="{ dim: loadingValue }">{{ value.text }}</pre>
          <div v-else-if="!value.result" class="redis-hint redis-pad">{{ t('redis.unsupportedKind', { kind: value.kind }) }}</div>
        </template>
        <div
          v-if="value?.result && !error"
          ref="tableRef"
          class="redis-table csv-preview selectable"
          :class="{ dim: loadingValue }"
          tabindex="-1"
          @click="csvTable.handleClick"
          @change="csvTable.handleChange"
          @keydown="onTableKeydown"
          v-html="tableHtml"
        ></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.redis-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
}

.redis-tab input,
.redis-tab select {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 12px;
  min-width: 0;
}

.redis-tab button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.redis-tab button:disabled {
  opacity: 0.5;
  cursor: default;
}

.redis-hint {
  color: var(--text-secondary);
  font-size: 12px;
  margin: 0;
}

.redis-pad {
  padding: 12px 16px;
}

.redis-error {
  padding: 8px 12px;
  border-left: 3px solid var(--danger);
  background: var(--bg-secondary);
  white-space: pre-wrap;
  font-size: 12px;
}

.redis-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.redis-side {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-right: 1px solid var(--border);
  min-height: 0;
}

.redis-side-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.redis-conn {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.redis-tab .redis-link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 11px;
}

.redis-key-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.redis-tab .redis-key-item {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  border: none;
  border-radius: 3px;
  background: none;
  text-align: left;
}

.redis-tab .redis-key-item:hover {
  background: var(--tab-hover-bg);
}

.redis-tab .redis-key-item.selected {
  background: var(--accent);
  color: var(--on-accent);
}

.redis-key-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.redis-key-kind {
  font-size: 11px;
  opacity: 0.7;
  flex-shrink: 0;
}

.redis-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.redis-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.redis-current {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.redis-meta {
  display: flex;
  gap: 12px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.redis-kind {
  font-weight: 600;
}

.redis-banner {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.redis-text {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 8px 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 表の見た目は `assets/csvTable.css`（`csv-preview`）。ここは置き場の寸法だけ。 */
.redis-table {
  flex: 1;
  overflow: auto;
  padding: 0 8px 8px;
  outline: none;
}

.redis-table.dim,
.redis-text.dim {
  opacity: 0.6;
}
</style>
