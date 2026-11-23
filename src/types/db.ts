import type { ShellType } from './tab'

/** DB ビューワ（#632）が扱う DB の種類。Rust の `db::sql::Engine` と同じ綴り。 */
export type DbEngine = 'mysql' | 'postgres'

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
