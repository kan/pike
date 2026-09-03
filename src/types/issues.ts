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

/** 1 件の issue（タブで読む用、#278）。書き込みは持たないので編集に要る情報は取らない。 */
export interface IssueDetail {
  title: string
  url: string
  /** `OPEN` / `CLOSED`。一覧と違い open 以外も開ける。 */
  state: string
  author: string
  createdAt: string
  body: string
  labels: IssueLabel[]
  comments: IssueComment[]
}

export interface IssueComment {
  author: string
  createdAt: string
  body: string
  url: string
}

export interface IssueListResult {
  issues: IssueSummary[]
  /** 未インストール・未認証・権限なしの理由。0 件と区別するために出す（実行した行込み）。 */
  error: string | null
}
