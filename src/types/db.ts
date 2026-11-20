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

export type DbDumpFormat = 'csv' | 'tsv'
