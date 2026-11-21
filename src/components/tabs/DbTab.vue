<script setup lang="ts">
/**
 * 簡易 DB ビューワ（#632）。接続先を選ぶ → テーブルを選ぶ → 中身 / スキーマを切り替える、の薄い外枠。
 *
 * **表は CSV プレビューの部品をそのまま使う**（`useCsvTable`）。ページ送り・表示件数・並べ替え・
 * 列と行の選択とコピーは新しいコードを持たない。接続とクエリは Rust（`src-tauri/src/db/`）で、
 * ここから渡せるのは接続先とテーブル名だけ（任意の SQL を受ける口は無い）。判断の記録は
 * `.claude/rules/db.md`。
 *
 * **パスワードはこのコンポーネントの中にだけ持つ**（タブの欄にもセッションにも書かない）。
 * コンテナのパスワードはフロントへ来ない（Rust が実行のたびにコンテナの環境変数から読む）。
 */
import { Copy, Database, RefreshCw, Save } from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useCsvTable } from '../../composables/useCsvTable'
import { useI18n } from '../../i18n'
import {
  buildDbTarget,
  type DbConnCandidate,
  dbCandidatesFromEnv,
  dbEngineOfImage,
  dbResultToCsv,
  defaultPort,
  formatDbResult,
  missingClients,
} from '../../lib/dbViewer'
import { hostDefaultShell } from '../../lib/host'
import { joinPath, pathSep } from '../../lib/paths'
import {
  dbContainerDefaults,
  dbDatabases,
  dbDump,
  dbRows,
  dbSchema,
  dbTables,
  fsReadFile,
  fsWriteFile,
  pickSaveFile,
} from '../../lib/tauri'
import { useDockerStore } from '../../stores/docker'
import { useProjectStore } from '../../stores/project'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { DbDumpFormat, DbEngine, DbResult, DbTable, DbTarget } from '../../types/db'
import type { DbTab } from '../../types/tab'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const dockerStore = useDockerStore()
const statusMessageStore = useStatusMessageStore()

const tab = computed(() => tabStore.tabs.find((x): x is DbTab => x.id === props.tabId && x.kind === 'db'))

// --- 接続先の入力 ---

/** 接続先の選択肢の値。`shell` か、コンテナの id。 */
const SHELL_SOURCE = 'shell'
const source = ref<string>(tab.value?.container?.id ?? SHELL_SOURCE)
const engine = ref<DbEngine>(tab.value?.container?.engine ?? 'mysql')
const host = ref('127.0.0.1')
const port = ref('')
const user = ref('')
const password = ref('')
const database = ref('')
/** コンテナの環境変数にパスワードがあるか（あれば空のままでよい）。 */
const containerHasPassword = ref(false)

/** 動いている MySQL / PostgreSQL のコンテナ（Docker パネルと同じ一覧から、イメージ名で選ぶ）。 */
const dbContainers = computed(() =>
  dockerStore.containers.flatMap((c) => {
    const e = dbEngineOfImage(c.image)
    return e && c.state === 'running' ? [{ id: c.id, name: c.composeService ?? c.name, engine: e }] : []
  }),
)

/** 開いたときのコンテナが一覧から消えていても、選択肢には残す（止まっている・まだ取れていない）。 */
const containerOptions = computed(() => {
  const list = dbContainers.value
  const initial = tab.value?.container
  return initial && !list.some((c) => c.id === initial.id) ? [initial, ...list] : list
})

const isContainer = computed(() => source.value !== SHELL_SOURCE)
const shell = computed(() => projectStore.shellForIO)

/** シェルの経路の説明（プロジェクトのシェル。WSL なら distro 名）。 */
const shellLabel = computed(() => {
  const s = shell.value
  return s.kind === 'wsl' ? `WSL (${s.distro})` : s.kind
})

// コンテナを選んだら、そのイメージで種類を決め、環境変数の既定を入れる。
watch(
  source,
  async (id) => {
    if (id === SHELL_SOURCE) return
    const c = containerOptions.value.find((x) => x.id === id)
    if (!c) return
    engine.value = c.engine
    try {
      const d = await dbContainerDefaults(id, c.engine)
      if (source.value !== id) return
      user.value = d.user ?? ''
      database.value = d.database ?? ''
      password.value = ''
      containerHasPassword.value = d.hasPassword
    } catch (e) {
      error.value = String(e)
    }
  },
  { immediate: true },
)

onMounted(async () => {
  // Docker パネルを開いていなくても候補を出す（一覧の取得はパネルと同じもの）。
  await dockerStore.refreshAll()
})

/** `.env` から拾った候補。押したときだけ読む。 */
const envCandidates = ref<DbConnCandidate[] | null>(null)

async function readEnv() {
  const root = projectStore.activeRoot
  if (!root) return
  try {
    const r = await fsReadFile(shell.value, joinPath(root, '.env', pathSep(shell.value)), undefined, {
      allowMissing: true,
    })
    envCandidates.value = r.isNew ? [] : dbCandidatesFromEnv(r.content)
    if (envCandidates.value.length > 0) applyCandidate(envCandidates.value[0])
  } catch (e) {
    error.value = String(e)
  }
}

function applyCandidate(c: DbConnCandidate) {
  engine.value = c.engine
  host.value = c.host
  port.value = c.port ? String(c.port) : ''
  user.value = c.user
  password.value = c.password
  database.value = c.database
}

function buildTarget(): DbTarget {
  const form = {
    engine: engine.value,
    host: host.value,
    port: port.value,
    user: user.value,
    password: password.value,
    database: database.value,
  }
  return buildDbTarget(
    form,
    isContainer.value ? { kind: 'container', containerId: source.value } : { kind: 'shell', shell: shell.value },
  )
}

// --- 接続してからの状態 ---

/** 接続したときの接続先（DB 名を除く）。null なら接続の画面を出す。 */
const connected = ref<DbTarget | null>(null)
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

/** 応答の取り違えを防ぐ番号（テーブルを続けて選んだとき、遅れて届いた古い結果を捨てる）。 */
let seq = 0

function errorText(e: unknown): string {
  const missing = missingClients(e)
  if (!missing) return String(e)
  const where = isContainer.value ? t('db.whereContainer') : t('db.whereShell', { shell: shellLabel.value })
  return t('db.clientNotFound', { clients: missing.join(' / '), where })
}

/** 接続し、DB とテーブルの一覧を読む。つなげたら true。 */
async function connect(): Promise<boolean> {
  const target = buildTarget()
  const my = ++seq
  loading.value = true
  error.value = null
  try {
    const [dbs, list] = await Promise.all([dbDatabases(target).catch(() => [] as string[]), dbTables(target)])
    if (my !== seq) return false
    connected.value = target
    databases.value = database.value && !dbs.includes(database.value) ? [database.value, ...dbs] : dbs
    tables.value = list
    selectedTable.value = null
    result.value = null
    return true
  } catch (e) {
    if (my === seq) error.value = errorText(e)
    return false
  } finally {
    if (my === seq) loading.value = false
  }
}

function disconnect() {
  seq++
  connected.value = null
  tables.value = []
  databases.value = []
  selectedTable.value = null
  result.value = null
  loading.value = false
}

/** DB を切り替える。テーブルの一覧を読み直す。 */
async function switchDatabase(db: string) {
  const prev = database.value
  database.value = db
  // つなげなかったら選択欄を元に戻す（一覧と中身はつながっている DB のままなので、食い違う）。
  if (!(await connect()) && database.value === db) database.value = prev
}

const filteredTables = computed(() => {
  const q = tableFilter.value.trim().toLowerCase()
  return q ? tables.value.filter((x) => x.name.toLowerCase().includes(q)) : tables.value
})

async function loadResult() {
  const target = connected.value
  const table = selectedTable.value
  if (!target || !table) return
  const my = ++seq
  loading.value = true
  error.value = null
  try {
    const r = view.value === 'rows' ? await dbRows(target, table) : await dbSchema(target, table)
    if (my !== seq) return
    result.value = r
  } catch (e) {
    if (my !== seq) return
    result.value = null
    error.value = errorText(e)
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
  const target = connected.value
  const table = selectedTable.value
  const r = result.value
  if (!target || !table || !r) return
  const suffix = view.value === 'schema' ? '-schema' : ''
  const path = await pickSaveFile(`${table}${suffix}.${format.value}`).catch(() => null)
  if (!path) return
  saving.value = true
  try {
    let count = r.rows.length
    if (view.value === 'rows') count = await dbDump(target, table, format.value, path)
    else await fsWriteFile(hostDefaultShell(), path, `${formatDbResult(r, format.value)}\n`)
    statusMessageStore.show({
      text: t('db.saved', { count: count.toLocaleString(), path }),
      variant: 'success',
    })
  } catch (e) {
    statusMessageStore.show({ text: errorText(e), variant: 'error' })
  } finally {
    saving.value = false
  }
}

const connectedLabel = computed(() => {
  const target = connected.value
  if (!target) return ''
  const v = target.via
  const via =
    v.kind === 'container'
      ? (containerOptions.value.find((c) => c.id === v.containerId)?.name ?? v.containerId.slice(0, 12))
      : `${target.host ?? 'localhost'}${target.port ? `:${target.port}` : ''}`
  return `${target.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} · ${via}`
})

const filterInput = useTemplateRef<HTMLInputElement>('filterInput')
watch(connected, (c) => {
  if (c) void nextTick(() => filterInput.value?.focus())
})
</script>

<template>
  <div class="db-tab">
    <!-- 接続先 -->
    <form v-if="!connected" class="db-connect" @submit.prevent="connect">
      <div class="db-connect-title"><Database :size="16" :stroke-width="2" />{{ t('db.connectTitle') }}</div>
      <label class="db-field">
        <span>{{ t('db.source') }}</span>
        <select v-model="source">
          <option v-for="c in containerOptions" :key="c.id" :value="c.id">
            {{ t('db.sourceContainer', { name: c.name }) }}
          </option>
          <option :value="SHELL_SOURCE">{{ t('db.sourceShell', { shell: shellLabel }) }}</option>
        </select>
      </label>
      <p v-if="!containerOptions.length" class="db-hint">{{ t('db.noContainers') }}</p>
      <label class="db-field">
        <span>{{ t('db.engine') }}</span>
        <select v-model="engine" :disabled="isContainer">
          <option value="mysql">MySQL / MariaDB</option>
          <option value="postgres">PostgreSQL</option>
        </select>
      </label>
      <template v-if="!isContainer">
        <label class="db-field">
          <span>{{ t('db.host') }}</span>
          <input v-model="host" type="text" spellcheck="false" placeholder="127.0.0.1" />
        </label>
        <label class="db-field">
          <span>{{ t('db.port') }}</span>
          <input v-model="port" type="text" inputmode="numeric" :placeholder="String(defaultPort(engine))" />
        </label>
      </template>
      <label class="db-field">
        <span>{{ t('db.user') }}</span>
        <input v-model="user" type="text" spellcheck="false" autocomplete="off" />
      </label>
      <label class="db-field">
        <span>{{ t('db.password') }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="off"
          :placeholder="isContainer && containerHasPassword ? t('db.passwordFromContainer') : ''"
        />
      </label>
      <label class="db-field">
        <span>{{ t('db.database') }}</span>
        <input v-model="database" type="text" spellcheck="false" />
      </label>
      <div class="db-actions">
        <button type="submit" class="db-primary" :disabled="loading">
          {{ loading ? t('common.loading') : t('db.connect') }}
        </button>
        <button v-if="!isContainer && projectStore.activeRoot" type="button" @click="readEnv">
          {{ t('db.fromEnv') }}
        </button>
        <select
          v-if="!isContainer && envCandidates && envCandidates.length > 1"
          @change="applyCandidate(envCandidates[Number(($event.target as HTMLSelectElement).value)])"
        >
          <option v-for="(c, i) in envCandidates" :key="i" :value="i">{{ c.source }}</option>
        </select>
        <span v-if="!isContainer && envCandidates && !envCandidates.length" class="db-hint">
          {{ t('db.envNone') }}
        </span>
      </div>
      <p class="db-hint">{{ t('db.passwordNotSaved') }}</p>
      <div v-if="error" class="db-error selectable">{{ error }}</div>
    </form>

    <!-- 接続したあと -->
    <div v-else class="db-body">
      <aside class="db-side">
        <div class="db-side-head">
          <span class="db-conn" :title="connectedLabel">{{ connectedLabel }}</span>
          <button type="button" class="db-link" @click="disconnect">{{ t('db.changeConnection') }}</button>
        </div>
        <select
          v-if="databases.length"
          class="db-db"
          :value="database"
          :title="t('db.database')"
          @change="switchDatabase(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!database" value="" disabled>{{ t('db.pickDatabase') }}</option>
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
          <div v-if="!tables.length" class="db-hint">{{ database ? t('db.noTables') : t('db.pickDatabase') }}</div>
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

.db-connect {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 480px;
  padding: 20px 24px;
  overflow-y: auto;
}

.db-connect-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-active);
  margin-bottom: 4px;
}

.db-field {
  display: grid;
  grid-template-columns: 120px 1fr;
  align-items: center;
  gap: 8px;
}

.db-field > span {
  color: var(--text-secondary);
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

.db-tab .db-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.db-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
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
