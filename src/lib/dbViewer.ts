/**
 * DB ビューワ（#632）の純粋な部分: コンテナのイメージから DB の種類を当てる、結果を CSV プレビューの
 * 表（`CsvData`）にする、CSV / TSV の文字列にする、`.env` から接続の候補を拾う。
 *
 * 接続とクエリは Rust（`src-tauri/src/db/`）が持つ。判断の記録は `.claude/rules/db.md`。
 */
import type { DbDumpFormat, DbEngine, DbResult, DbTarget, DbVia } from '../types/db'
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

/** Rust がクライアントを見つけられなかったときのエラーの接頭辞（`db::CLIENT_NOT_FOUND`）。 */
const CLIENT_NOT_FOUND = 'db-client-not-found:'

/** エラーがクライアントの不在なら、試した名前（`mysql` / `mariadb`）を返す。 */
export function missingClients(error: unknown): string[] | null {
  const s = String(error)
  return s.startsWith(CLIENT_NOT_FOUND) ? s.slice(CLIENT_NOT_FOUND.length).split(',') : null
}
