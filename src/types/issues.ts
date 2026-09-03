/** GitHub issue の一覧（#278）。`src-tauri/src/issues/mod.rs` の serde 出力に対応する。 */

export interface IssueLabel {
  name: string
  /** GitHub のラベル色（`a2eeef` のような 6 桁 hex、`#` なし）。 */
  color: string
}

export interface IssueSummary {
  number: number
  title: string
  url: string
  author: string
  updatedAt: string
  labels: IssueLabel[]
  /** 親 issue の番号（sub-issue のとき）。一覧に居ない親は木を組むとき無視する。 */
  parent: number | null
}

export interface IssueListResult {
  issues: IssueSummary[]
  /** 未インストール・未認証・権限なしの理由。0 件と区別するために出す（実行した行込み）。 */
  error: string | null
}
