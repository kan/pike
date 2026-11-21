<script setup lang="ts">
/**
 * 簡易 DB ビューワ（#632）のタブ。つなげた接続先（`tab.target`）について、テーブルを選び、
 * 中身 / スキーマを切り替えて見る。
 *
 * **接続のフォームはここに持たない。** 接続先を選ぶのは DB パネル、入力するのは接続のダイアログ
 * （`components/DbConnectDialog.vue`）で、タブはつなげたことを確かめた接続先しか受け取らない
 * （`stores/db.ts` の `open`）。「接続先を変える」もダイアログを開くだけ。
 *
 * **表は CSV プレビューの部品をそのまま使う**（`useCsvTable`）。ページ送り・表示件数・並べ替え・
 * 列と行の選択とコピーは新しいコードを持たない。接続とクエリは Rust（`src-tauri/src/db/`）で、
 * ここから渡せるのは接続先とテーブル名だけ（任意の SQL を受ける口は無い）。判断の記録は
 * `.claude/rules/db.md`。
 */
import { Copy, RefreshCw, Save } from 'lucide-vue-next'
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useCsvTable } from '../../composables/useCsvTable'
import { useI18n } from '../../i18n'
import { dbErrorText, dbResultToCsv, ENGINE_LABELS, formatDbResult } from '../../lib/dbViewer'
import { hostDefaultShell } from '../../lib/host'
import { dbDatabases, dbDump, dbRows, dbSchema, dbTables, fsWriteFile, pickSaveFile } from '../../lib/tauri'
import { useDbStore } from '../../stores/db'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { DbDumpFormat, DbResult, DbTable, DbTarget } from '../../types/db'
import type { DbTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const db = useDbStore()
const statusMessageStore = useStatusMessageStore()

const tab = computed(() => tabStore.tabs.find((x): x is DbTab => x.id === props.tabId && x.kind === 'db'))
const target = computed(() => tab.value?.target)

const databases = ref<string[]>([])
const tables = ref<DbTable[]>([])
const tableFilter = ref('')
const selectedTable = ref<string | null>(null)
const view = ref<'rows' | 'schema'>('rows')
/** 結果は丸ごと差し替えるだけなので、行を深いリアクティブにしない（最大 2,000 行 × 列）。 */
const result = shallowRef<DbResult | null>(null)
const loading = ref(false)
/** 書き出しの最中か（テーブル全体を書くので時間がかかりうる。重ねて押させない）。 */
const saving = ref(false)
const error = ref<string | null>(null)
const format = ref<DbDumpFormat>('csv')

const filterInput = useTemplateRef<HTMLInputElement>('filterInput')

/** 応答の取り違えを防ぐ番号（テーブルを続けて選んだとき、遅れて届いた古い結果を捨てる）。 */
let seq = 0

/**
 * 接続先の DB とテーブルの一覧を読む。開いた直後はストアがつないだときに読んだ一覧を使う
 * （同じ問い合わせを 2 回流さない）。
 */
async function loadTables(to: DbTarget) {
  const my = ++seq
  loading.value = true
  error.value = null
  selectedTable.value = null
  result.value = null
  try {
    const pre = db.takePrefetched(props.tabId)
    const [dbs, list] = pre
      ? [pre.databases, pre.tables]
      : await Promise.all([dbDatabases(to).catch(() => [] as string[]), dbTables(to)])
    if (my !== seq) return
    const current = to.database
    databases.value = current && !dbs.includes(current) ? [current, ...dbs] : dbs
    tables.value = list
    void nextTick(() => filterInput.value?.focus())
  } catch (e) {
    if (my === seq) error.value = dbErrorText(e, to)
  } finally {
    if (my === seq) loading.value = false
  }
}

// 開いたときと、接続先を差し替えたとき（「接続先を変える」・DB の切り替え）に読み直す。
watch(target, (to) => to && void loadTables(to), { immediate: true })

/**
 * DB を切り替える。パネルから開くのと同じく、つないで確かめてからこのタブの接続先を差し替える
 * （`db.open`）。つなげなければ接続のダイアログが出て、選択欄は今の DB のまま（一覧と中身は
 * つながっている DB のものなので、食い違わせない）。
 */
async function switchDatabase(select: HTMLSelectElement) {
  const tb = tab.value
  if (!tb) return
  // DB を切り替えただけでは保存しない（DB ごとに保存した接続の行が増えて、上限で本当に保存した
  // 接続を押し出すため）。
  const ok = await db.open({ ...tb.target, database: select.value }, { tabId: tb.id, save: false })
  // 接続先が変わらなければ Vue は選択欄を描き直さないので、選んだ値を自分で戻す。
  if (!ok) select.value = tb.target.database ?? ''
}

const filteredTables = computed(() => {
  const q = tableFilter.value.trim().toLowerCase()
  return q ? tables.value.filter((x) => x.name.toLowerCase().includes(q)) : tables.value
})

async function loadResult() {
  const to = target.value
  const table = selectedTable.value
  if (!to || !table) return
  const my = ++seq
  loading.value = true
  error.value = null
  try {
    const r = view.value === 'rows' ? await dbRows(to, table) : await dbSchema(to, table)
    if (my !== seq) return
    result.value = r
  } catch (e) {
    if (my !== seq) return
    result.value = null
    error.value = dbErrorText(e, to)
  } finally {
    if (my === seq) loading.value = false
  }
}

// --- 表（CSV プレビューの部品） ---

const tableRef = ref<HTMLElement>()
const csvData = computed(() => (result.value ? dbResultToCsv(result.value) : null))
const csvTable = useCsvTable({ container: tableRef, data: () => csvData.value })
const tableHtml = csvTable.html

// 別のテーブル・別の表示に移ったら読み直し、並べ替えとページを初めに戻す（別の表の列番号で
// 並べない）。「更新」での読み直しでは並べ替えを残す（並べ替えたまま最新を見たい）。
watch([selectedTable, view], () => {
  // 並べ替えもページも元から初めのままだと `useCsvTable` の側で選択が捨てられないので、ここで捨てる
  // （残すと前の表で選んだ列が、新しい表の同じ位置の列として選ばれたままになる）。
  csvTable.selection.clear()
  csvTable.setSort(null)
  void loadResult()
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

/** 表示中の結果（読み込んだ全行。ページで区切らない）を CSV / TSV でコピーする。 */
function copyResult() {
  const r = result.value
  if (!r) return
  copyText(formatDbResult(r, format.value), t('db.copied', { count: r.rows.length.toLocaleString() }))
}

/**
 * ファイルに保存する。**中身はテーブル全体を書き出す**（表示の上限で切らない。Rust がクライアントの
 * 出力を読みながら書くので、フロントを経由しない）。スキーマは表示している表をそのまま書く。
 */
async function saveResult() {
  const to = target.value
  const table = selectedTable.value
  const r = result.value
  if (!to || !table || !r) return
  const suffix = view.value === 'schema' ? '-schema' : ''
  const path = await pickSaveFile(`${table}${suffix}.${format.value}`).catch(() => null)
  if (!path) return
  saving.value = true
  try {
    let count = r.rows.length
    if (view.value === 'rows') count = await dbDump(to, table, format.value, path)
    else await fsWriteFile(hostDefaultShell(), path, `${formatDbResult(r, format.value)}\n`)
    statusMessageStore.show({
      text: t('db.saved', { count: count.toLocaleString(), path }),
      variant: 'success',
    })
  } catch (e) {
    statusMessageStore.show({ text: dbErrorText(e, to), variant: 'error' })
  } finally {
    saving.value = false
  }
}

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
  <div class="db-tab">
    <div class="db-body">
      <aside class="db-side">
        <div class="db-side-head">
          <span class="db-conn" :title="connectedLabel">{{ connectedLabel }}</span>
          <button type="button" class="db-link" @click="changeConnection">{{ t('db.changeConnection') }}</button>
        </div>
        <select
          v-if="databases.length"
          class="db-db"
          :value="target?.database ?? ''"
          :title="t('db.database')"
          @change="switchDatabase($event.target as HTMLSelectElement)"
        >
          <option v-if="!target?.database" value="" disabled>{{ t('db.pickDatabase') }}</option>
          <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
        </select>
        <input
          ref="filterInput"
          v-model="tableFilter"
          class="db-filter"
          type="text"
          spellcheck="false"
          :placeholder="t('db.filterTables')"
        />
        <div class="db-table-list">
          <button
            v-for="x in filteredTables"
            :key="x.name"
            type="button"
            class="db-table-item"
            :class="{ selected: x.name === selectedTable }"
            :title="x.kind"
            @click="selectedTable = x.name"
          >
            <span class="db-table-name">{{ x.name }}</span>
            <span v-if="x.approxRows !== null" class="db-table-rows">{{ x.approxRows.toLocaleString() }}</span>
          </button>
          <div v-if="!tables.length && !loading" class="db-hint">
            {{ target?.database ? t('db.noTables') : t('db.pickDatabase') }}
          </div>
        </div>
      </aside>

      <section class="db-main">
        <div class="db-toolbar">
          <div class="db-views">
            <button type="button" :class="{ active: view === 'rows' }" @click="view = 'rows'">{{ t('db.rows') }}</button>
            <button type="button" :class="{ active: view === 'schema' }" @click="view = 'schema'">
              {{ t('db.schema') }}
            </button>
          </div>
          <span class="db-current">{{ selectedTable ?? '' }}</span>
          <button type="button" :title="t('common.refresh')" :disabled="!selectedTable || loading" @click="loadResult">
            <RefreshCw :size="13" :stroke-width="2" />
          </button>
          <select v-model="format" :title="t('db.format')">
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
          </select>
          <!-- 読み込み中は前の表の結果が残っているので、保存と同じく押させない。 -->
          <button type="button" :title="t('db.copyHint')" :disabled="!result || loading" @click="copyResult">
            <Copy :size="13" :stroke-width="2" /><span>{{ t('db.copy') }}</span>
          </button>
          <button
            type="button"
            :title="view === 'rows' ? t('db.saveRowsHint') : t('db.saveSchemaHint')"
            :disabled="!result || loading || saving"
            @click="saveResult"
          >
            <Save :size="13" :stroke-width="2" /><span>{{ saving ? t('db.saving') : t('db.save') }}</span>
          </button>
        </div>
        <div v-if="result?.truncated && view === 'rows'" class="db-banner">
          {{ t('db.truncated', { limit: result.rows.length.toLocaleString() }) }}
        </div>
        <div v-if="error" class="db-error selectable">{{ error }}</div>
        <div v-else-if="loading && !result" class="db-hint db-pad">{{ t('common.loading') }}</div>
        <div v-else-if="!selectedTable" class="db-hint db-pad">{{ t('db.pickTable') }}</div>
        <div
          v-if="result && !error"
          ref="tableRef"
          class="db-table csv-preview selectable"
          :class="{ dim: loading }"
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
.db-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
}

.db-tab input,
.db-tab select {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 12px;
  min-width: 0;
}

.db-tab button {
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

.db-tab button:disabled {
  opacity: 0.5;
  cursor: default;
}

.db-hint {
  color: var(--text-secondary);
  font-size: 12px;
  margin: 0;
}

.db-pad {
  padding: 12px 16px;
}

.db-error {
  padding: 8px 12px;
  border-left: 3px solid var(--danger);
  background: var(--bg-secondary);
  white-space: pre-wrap;
  font-size: 12px;
}

.db-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.db-side {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-right: 1px solid var(--border);
  min-height: 0;
}

.db-side-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.db-conn {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-tab .db-link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 11px;
}

.db-table-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.db-tab .db-table-item {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  border: none;
  border-radius: 3px;
  background: none;
  text-align: left;
}

.db-tab .db-table-item:hover {
  background: var(--tab-hover-bg);
}

.db-tab .db-table-item.selected {
  background: var(--accent);
  color: var(--on-accent);
}

.db-table-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-table-rows {
  font-size: 11px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.db-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.db-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.db-views {
  display: flex;
}

.db-views button {
  border-radius: 0;
}

.db-views button:first-child {
  border-radius: 3px 0 0 3px;
}

.db-views button:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}

.db-tab .db-views button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.db-current {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-banner {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

/* 表の見た目は `assets/csvTable.css`（`csv-preview`）。ここは置き場の寸法だけ。 */
.db-table {
  flex: 1;
  overflow: auto;
  padding: 0 8px 8px;
  outline: none;
}

.db-table.dim {
  opacity: 0.6;
}
</style>
