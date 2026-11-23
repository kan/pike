import type { ShellType } from './tab'

/**
 * DB ビューワ（#632）が扱う DB の種類。`mysql` / `postgres` は Rust の `db::sql::Engine` と同じ綴り。
 * `redis`（#647）は SQL の DB ではないので Rust の `Engine` には無く、別のコマンド（`db::redis`）を通る。
 */
export type DbEngine = 'mysql' | 'postgres' | 'redis'

/** SQL の DB（`db_*` のコマンドが受ける種類）。 */
export type SqlEngine = Exclude<DbEngine, 'redis'>

/** クライアント（`mysql` / `psql`）をどこで起こすか。Rust の `db::DbVia`。 */
export type DbVia = { kind: 'container'; containerId: string } | { kind: 'shell'; shell: ShellType }

/**
 * 接続先（Rust の `db::DbTarget`）。空の欄は「指定なし」で、コンテナならコンテナの環境変数の値、
 * シェルならクライアントの既定になる。**パスワードは保存しない**（タブの中だけに持つ）。
 */
export interface DbTarget {
  engine: DbEngine
  via: DbVia
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
}

/** 表の結果。`null` が NULL。`truncated` は表示の上限で切ったか。 */
export interface DbResult {
  columns: string[]
  rows: (string | null)[][]
  truncated: boolean
}

export interface DbTable {
  name: string
  /** `BASE TABLE` / `VIEW` など（information_schema の `table_type`）。 */
  kind: string
  /** 統計からの推定の行数。分からなければ null。 */
  approxRows: number | null
}

/** コンテナの環境変数から読んだ接続の既定。パスワードそのものは返らない。 */
export interface DbContainerDefaults {
  user: string | null
  database: string | null
  hasPassword: boolean
}

/** つないでみた結果（Rust の `db::DbProbe`）。 */
export interface DbProbe {
  /** 今の DB。MySQL で DB を選ばずにつないだときは null。 */
  current: string | null
  /** 見られる DB の一覧（システムの DB を除く）。取れなかったときは null（空の一覧とは別）。 */
  databases: string[] | null
  tables: DbTable[]
}

export type DbDumpFormat = 'csv' | 'tsv'

/**
 * 入力した SQL の結果（Rust の `db::DbExec`、#646）。表を返す 1 つの文は表で、それ以外（DDL・書き込み・
 * 複数の文）はクライアントが人向けに出したログで返る。`truncated` はログを上限で切ったか、`tables` は
 * 実行のあとのテーブルの一覧（DDL で増減するので Rust が同じ接続で読み直す。取れなければ null）。
 */
export type DbExec =
  | { kind: 'rows'; result: DbResult }
  | { kind: 'log'; text: string; truncated: boolean; tables: DbTable[] | null }

/** Redis の DB（番号とキーの数。Rust の `db::redis::RedisDatabase`）。 */
export interface RedisDatabase {
  index: number
  /** キーの数。`INFO` が読めなかった（ACL で拒否された）ときは null。 */
  keys: number | null
}

/** Redis のキー。`kind` は `TYPE` の答え（`string` / `list` / `hash` / `set` / `zset` / `stream` など）。 */
export interface RedisKey {
  /** 見せる名前。バイナリの名前（UTF-8 でない・制御文字や改行を含む）は redis-cli の表記（`\xHH` など）。 */
  name: string
  /** バイナリの名前のバイト列（16 進）。値を開くときはこれを返す（表記からは引き直せない）。 */
  raw: string | null
  kind: string
}

/** キーの一覧。`truncated` は上限（5,000 件か `SCAN` の回数）で止めたか。 */
export interface RedisKeyList {
  keys: RedisKey[]
  truncated: boolean
}

/** つないでみた結果（Rust の `db::redis::RedisProbe`）。今の DB のキーの一覧も持つ。 */
export interface RedisProbe {
  current: number
  databases: RedisDatabase[]
  keys: RedisKeyList
}

/** 1 つのキーの値（Rust の `db::redis::RedisValue`）。string は `text`、ほかの型は `result`（表）。 */
export interface RedisValue {
  kind: string
  /** 残りの秒。期限が無ければ -1。`TTL` が読めなかった（ACL で拒否された）ときは null。 */
  ttl: number | null
  /** 要素の数（string はバイト数）。 */
  length: number | null
  text: string | null
  result: DbResult | null
  /** 先頭だけを読んだか。 */
  truncated: boolean
  /** string の値がバイナリで、`text` を redis-cli の表記で書いたか。 */
  binary: boolean
}
