/**
 * DB ビューワ（#632）の純粋な部分: コンテナのイメージから DB の種類を当てる、結果を CSV プレビューの
 * 表（`CsvData`）にする、CSV / TSV の文字列にする、`.env` から接続の候補を拾う。
 *
 * 接続とクエリは Rust（`src-tauri/src/db/`）が持つ。判断の記録は `.claude/rules/db.md`。
 */

import { t } from '../i18n'
import type { DbDumpFormat, DbEngine, DbProbe, DbResult, DbTable, DbTarget, DbVia } from '../types/db'
import { type ShellType, shellFromId, shellId, shellProfileLabel } from '../types/tab'
import type { CsvData } from './csvPreview'

/**
 * イメージ名から DB の種類を当てる。見るのはリポジトリ名の最後の部分（`library/mysql:8` なら
 * `mysql`、`postgis/postgis` なら `postgis`）。公式イメージと、それを土台にした定番のものだけ。
 */
export function dbEngineOfImage(image: string): DbEngine | null {
  const repo = image.toLowerCase().split('@')[0]
  const last = repo.slice(repo.lastIndexOf('/') + 1).split(':')[0]
  if (/mysql|mariadb|percona/.test(last)) return 'mysql'
  if (/postgres|postgis|timescaledb|pgvector/.test(last)) return 'postgres'
  return null
}

/** 既定のポート（入力欄のプレースホルダ）。 */
export function defaultPort(engine: DbEngine): number {
  return engine === 'mysql' ? 3306 : 5432
}

/** 結果を CSV プレビューの表にする。セルは Rust が分けたまま渡す（NULL は `null` のまま）。 */
export function dbResultToCsv(result: DbResult): CsvData {
  return {
    headers: result.columns,
    rows: result.rows.map((cells, i) => ({ num: i + 1, cells })),
    delimiter: '\t',
  }
}

/**
 * テーブルの一覧の右に出す文字（#646）。VIEW は件数の代わりに `VIEW` と出す（件数の推定を持たない
 * ので空になり、テーブルと見分けがつかないため）。`kind` は information_schema の `table_type` で、
 * MySQL のシステムのビューは `SYSTEM VIEW` になる。
 */
export function tableBadge(table: DbTable): string | null {
  if (/\bVIEW$/i.test(table.kind)) return 'VIEW'
  return table.approxRows === null ? null : table.approxRows.toLocaleString()
}

/** 接続の画面の入力。空の欄は「指定なし」。 */
export interface DbConnForm {
  engine: DbEngine
  host: string
  port: string
  user: string
  password: string
  database: string
}

/**
 * 入力から接続先を組む。空の欄は `undefined` にする（Rust 側で既定に落ちる）。ホストとポートは
 * シェルの経路だけ（コンテナはソケットでつなぐ）。範囲外のポートは指定なしと同じ。
 */
export function buildDbTarget(form: DbConnForm, via: DbVia): DbTarget {
  const target: DbTarget = {
    engine: form.engine,
    via,
    user: form.user || undefined,
    password: form.password || undefined,
    database: form.database || undefined,
  }
  if (via.kind === 'shell') {
    target.host = form.host || undefined
    target.port = parsePort(form.port) ?? undefined
  }
  return target
}

/** 1〜65535 の整数として読めればその値、読めなければ null。 */
export function parsePort(s: string | undefined): number | null {
  const n = Number(s)
  return s && Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/**
 * 結果を CSV / TSV の文字列にする（見出しを含む）。規則は書き出し（Rust の `sql::format_record`）と
 * 同じで、**NULL は空の欄、CSV では空文字を `""` にして区別する**。
 */
export function formatDbResult(result: DbResult, format: DbDumpFormat): string {
  const delim = format === 'csv' ? ',' : '\t'
  const cell = (v: string | null) => {
    if (v === null) return ''
    const quote = v.includes(delim) || /["\r\n]/.test(v) || (format === 'csv' && v === '')
    return quote ? `"${v.replaceAll('"', '""')}"` : v
  }
  return [result.columns, ...result.rows].map((r) => r.map(cell).join(delim)).join('\n')
}

/** `.env` などから拾った接続の候補。パスワードはファイルに書いてあれば入れる（保存はしない）。 */
export interface DbConnCandidate {
  /** どこから拾ったか（`DATABASE_URL` など）。 */
  source: string
  engine: DbEngine
  host: string
  port: number | null
  user: string
  password: string
  database: string
}

const URL_ENGINES: Record<string, DbEngine> = {
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  pgsql: 'postgres',
}

/**
 * `mysql://user:pass@host:3306/db` の形を読む。スキームの `+` 以降（`postgresql+psycopg2`）は
 * ドライバの指定なので無視する。読めなければ null。
 */
export function parseDatabaseUrl(url: string, source = 'DATABASE_URL'): DbConnCandidate | null {
  // ホストは角括弧の IPv6（`[::1]`）か、`:` `/` `?` `#` を含まない名前。IPv6 の角括弧は URL の
  // 書き方なので、クライアントへ渡す値からは外す（`--host=::1`）。
  const m =
    /^([a-z0-9]+)(?:\+[a-z0-9]+)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(?:\[([^\]/?#]*)\]|([^:/?#]*))(?::(\d+))?(?:\/([^?#]*))?/i.exec(
      url.trim(),
    )
  if (!m) return null
  const engine = URL_ENGINES[m[1].toLowerCase()]
  if (!engine) return null
  const dec = (s: string | undefined) => {
    try {
      return decodeURIComponent(s ?? '')
    } catch {
      return s ?? ''
    }
  }
  return {
    source,
    engine,
    user: dec(m[2]),
    password: dec(m[3]),
    host: m[4] ?? dec(m[5]),
    port: m[6] ? Number(m[6]) : null,
    database: dec(m[7]),
  }
}

/** `.env` の `KEY=VALUE` を読む（`export ` と引用符を外す。`#` で始まる行は飛ばす）。 */
export function parseDotEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const q = value[0]
    const close = q === '"' || q === "'" ? value.indexOf(q, 1) : -1
    // 引用符で囲んだ値は閉じの引用符まで（後ろのコメントは捨てる）。囲んでいなければ ` #` 以降を捨てる。
    if (close > 0) value = value.slice(1, close)
    else value = value.replace(/\s+#.*$/, '')
    vars.set(m[1], value)
  }
  return vars
}

/**
 * `.env` から接続の候補を拾う。`DATABASE_URL`（名前が `DATABASE_URL` で終わるものと `DB_URL`）と、
 * Laravel の `DB_CONNECTION` / `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD`。
 */
export function dbCandidatesFromEnv(text: string): DbConnCandidate[] {
  const vars = parseDotEnv(text)
  const out: DbConnCandidate[] = []
  for (const [key, value] of vars) {
    if (!(key.endsWith('DATABASE_URL') || key === 'DB_URL')) continue
    const c = parseDatabaseUrl(value, key)
    if (c) out.push(c)
  }
  const conn = vars.get('DB_CONNECTION')?.toLowerCase()
  const engine = conn ? URL_ENGINES[conn] : undefined
  if (engine) {
    out.push({
      source: 'DB_CONNECTION',
      engine,
      host: vars.get('DB_HOST') ?? '',
      port: parsePort(vars.get('DB_PORT')),
      user: vars.get('DB_USERNAME') ?? '',
      password: vars.get('DB_PASSWORD') ?? '',
      database: vars.get('DB_DATABASE') ?? '',
    })
  }
  return out
}

// --- 接続の候補（DB パネルと接続のダイアログが共有する） ---

/**
 * 保存する接続（#632）。**パスワードは持たない**。保存するのはローカル / WSL の経路だけ
 * （コンテナは動いているものを毎回一覧から出し、ユーザー名などはコンテナの環境変数から読む）。
 */
export interface DbSavedConnection {
  engine: DbEngine
  shell: ShellType
  host: string
  port: number | null
  user: string
  database: string
}

/** パネルに並べる接続先 1 つ。`target` は押したときにそのまま試す接続先。 */
export interface DbCandidate {
  /** 同じ接続先かの判定に使う（`connectionKey`）。 */
  key: string
  /** どこから来たか。`saved` だけが消せる。 */
  kind: 'container' | 'saved' | 'env'
  label: string
  /** 補足（コンテナならイメージ、`.env` なら変数名）。 */
  detail: string
  target: DbTarget
}

/** 保存しておく接続の数の上限（古いものから落とす）。 */
const DB_SAVED_MAX = 20

/**
 * 接続先の同一性。コンテナはコンテナの id、ローカル / WSL はシェル・種類・ホスト・ポート・
 * ユーザー・DB 名で決める（パスワードは含めない）。空の欄と未指定は同じに扱う。
 */
export function connectionKey(target: DbTarget): string {
  if (target.via.kind === 'container') return `container:${target.via.containerId}`
  const parts = [
    target.engine,
    shellId(target.via.shell),
    target.host ?? '',
    target.port ?? '',
    target.user ?? '',
    target.database ?? '',
  ]
  return `shell:${JSON.stringify(parts)}`
}

/** 保存した接続から接続先を組む（パスワードは無い）。 */
export function savedToTarget(s: DbSavedConnection): DbTarget {
  return {
    engine: s.engine,
    via: { kind: 'shell', shell: s.shell },
    host: s.host || undefined,
    port: s.port ?? undefined,
    user: s.user || undefined,
    database: s.database || undefined,
  }
}

/** 接続先から保存する形にする。コンテナの接続は保存しないので null。 */
export function targetToSaved(target: DbTarget): DbSavedConnection | null {
  if (target.via.kind !== 'shell') return null
  return {
    engine: target.engine,
    shell: target.via.shell,
    host: target.host ?? '',
    port: target.port ?? null,
    user: target.user ?? '',
    database: target.database ?? '',
  }
}

/** ローカル / WSL の接続先の表示名（`app@127.0.0.1:3306/app`）。空の欄は既定の値で補う。 */
export function describeShellTarget(target: DbTarget): string {
  const host = target.host || 'localhost'
  const port = target.port ?? defaultPort(target.engine)
  const user = target.user ? `${target.user}@` : ''
  const db = target.database ? `/${target.database}` : ''
  return `${user}${host}:${port}${db}`
}

/** 種類の表示名（ダイアログの選択肢、タブとパネルの添え書き）。 */
export const ENGINE_LABELS: Record<DbEngine, string> = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL' }

/** `.env` の候補から接続先を組む（`savedToTarget` と対。パスワードは `.env` に書いてあれば入る）。 */
function envToTarget(e: DbConnCandidate, shell: ShellType): DbTarget {
  return {
    engine: e.engine,
    via: { kind: 'shell', shell },
    host: e.host || undefined,
    port: e.port ?? undefined,
    user: e.user || undefined,
    password: e.password || undefined,
    database: e.database || undefined,
  }
}

/**
 * パネルに並べる接続先。並びは「動いているコンテナ → 保存した接続 → `.env` の候補」。
 * `.env` の候補が保存した接続と同じなら、保存した側の行に `.env` のパスワードを持たせて 1 行にする
 * （押したときにそのまま接続できるように。パスワードは保存しない）。
 */
export function buildDbCandidates(input: {
  containers: { id: string; name: string; image: string; engine: DbEngine }[]
  saved: DbSavedConnection[]
  env: DbConnCandidate[]
  shell: ShellType
}): DbCandidate[] {
  const out: DbCandidate[] = input.containers.map((c) => {
    const target: DbTarget = { engine: c.engine, via: { kind: 'container', containerId: c.id } }
    return { key: connectionKey(target), kind: 'container', label: c.name, detail: c.image, target }
  })
  const envByKey = new Map<string, { source: string; target: DbTarget }>()
  for (const e of input.env) {
    const target = envToTarget(e, input.shell)
    const key = connectionKey(target)
    if (!envByKey.has(key)) envByKey.set(key, { source: e.source, target })
  }
  for (const s of input.saved) {
    const target = savedToTarget(s)
    const key = connectionKey(target)
    const env = envByKey.get(key)
    if (env) {
      target.password = env.target.password
      envByKey.delete(key)
    }
    out.push({ key, kind: 'saved', label: describeShellTarget(target), detail: ENGINE_LABELS[s.engine], target })
  }
  for (const [key, { source, target }] of envByKey) {
    out.push({ key, kind: 'env', label: describeShellTarget(target), detail: `.env ${source}`, target })
  }
  return out
}

const savedKey = (s: DbSavedConnection) => connectionKey(savedToTarget(s))

/** 保存した接続を先頭へ足す（同じ接続は 1 つにまとめ、`DB_SAVED_MAX` を超えたら古いものを落とす）。 */
export function upsertSaved(list: DbSavedConnection[], s: DbSavedConnection): DbSavedConnection[] {
  const key = savedKey(s)
  return [s, ...list.filter((x) => savedKey(x) !== key)].slice(0, DB_SAVED_MAX)
}

/** 保存した接続を消す。 */
export function removeSaved(list: DbSavedConnection[], key: string): DbSavedConnection[] {
  return list.filter((x) => savedKey(x) !== key)
}

/**
 * つないでみた結果（`DbProbe`）をどう扱うか。
 *
 * - `ok`：DB が決まっている。タブを開く（テーブルが無くても開く。DB を選んだうえで空なのは
 *   正しい状態で、タブの中で DB を切り替えられる）
 * - `pick`：DB を選ばずにつないだが、見られる DB がちょうど 1 つ。それを選んでつなぎ直す
 *   （選び方が 1 通りしか無いので、聞かずに進める）
 * - `ask`：DB を選ばずにつないで、選びようが決まらない。接続のダイアログで DB 名を聞く
 *   （`reason` で文言を変え、`choices` を選択肢に出す）
 *
 * **DB の一覧が取れないこと（`databases` が null）と、DB が無いこと（空の一覧）を分ける。**
 * 前者は権限などで一覧を見せてもらえないだけなので、DB 名を入れればつながりうる。
 */
export type DbProbeVerdict =
  | { kind: 'ok' }
  | { kind: 'pick'; database: string }
  | { kind: 'ask'; reason: 'noDatabase' | 'noUserDatabases' | 'noDatabaseList'; choices: string[] }

export function judgeProbe(probe: DbProbe): DbProbeVerdict {
  if (probe.current) return { kind: 'ok' }
  const dbs = probe.databases
  if (dbs === null) return { kind: 'ask', reason: 'noDatabaseList', choices: [] }
  if (dbs.length === 0) return { kind: 'ask', reason: 'noUserDatabases', choices: [] }
  if (dbs.length === 1) return { kind: 'pick', database: dbs[0] }
  return { kind: 'ask', reason: 'noDatabase', choices: dbs }
}

/** `ask` のときにダイアログへ出す文言。 */
export function probeAskText(reason: Extract<DbProbeVerdict, { kind: 'ask' }>['reason']): string {
  return t(
    reason === 'noDatabase'
      ? 'db.askDatabase'
      : reason === 'noUserDatabases'
        ? 'db.askNoUserDatabases'
        : 'db.askDatabaseName',
  )
}

/** エラーの文言。クライアントが無いときは、どこに何が無いかを言う。 */
export function dbErrorText(error: unknown, target: DbTarget): string {
  const missing = missingClients(error)
  if (!missing) return String(error)
  const via = target.via
  const where =
    via.kind === 'container' ? t('db.whereContainer') : t('db.whereShell', { shell: shellProfileLabel(via.shell) })
  return t('db.clientNotFound', { clients: missing.join(' / '), where })
}

/** localStorage から読んだ値を検める。形の合わないものは落とす（手で書き換えられうる）。 */
export function parseSavedConnections(raw: unknown): DbSavedConnection[] {
  if (!Array.isArray(raw)) return []
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return raw.flatMap((x): DbSavedConnection[] => {
    if (typeof x !== 'object' || x === null) return []
    const o = x as Record<string, unknown>
    const engine = o.engine === 'mysql' || o.engine === 'postgres' ? o.engine : null
    // シェルの妥当性は `shellId` と `shellFromId` の往復で見る（`stores/settings.ts` の `sanitizeShell`
    // と同じ。判定を写すと、シェルの種類を増やしたときに片方だけ取り残される）。
    // ただし `shellId` は distro の無い WSL を `wsl:undefined` にして往復を通すので、distro だけは先に見る。
    const raw = o.shell as ShellType | undefined
    const wslOk = raw?.kind !== 'wsl' || typeof raw.distro === 'string'
    const shell = typeof raw?.kind === 'string' && wslOk ? shellFromId(shellId(raw)) : null
    if (!engine || !shell) return []
    const port = typeof o.port === 'number' && Number.isInteger(o.port) ? o.port : null
    return [{ engine, shell, host: str(o.host), port, user: str(o.user), database: str(o.database) }]
  })
}

/** Rust がクライアントを見つけられなかったときのエラーの接頭辞（`db::CLIENT_NOT_FOUND`）。 */
const CLIENT_NOT_FOUND = 'db-client-not-found:'

/** エラーがクライアントの不在なら、試した名前（`mysql` / `mariadb`）を返す。 */
export function missingClients(error: unknown): string[] | null {
  const s = String(error)
  return s.startsWith(CLIENT_NOT_FOUND) ? s.slice(CLIENT_NOT_FOUND.length).split(',') : null
}
