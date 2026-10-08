/** CI の実行の一覧（#457）。`src-tauri/src/ci/mod.rs` の serde 出力に対応する。 */

/** 扱う CI。Rust の `Provider`。 */
export type CiProvider = 'github' | 'circleci'

/** run・ワークフロー・job の状態。Rust の `RunState`（待ちも `running` に入る）。 */
export type CiState = 'running' | 'success' | 'failure' | 'cancelled' | 'skipped'

export interface CiRun {
  /** GitHub は run の番号（数字の文字列）、CircleCI は run の UUID。 */
  id: string
  title: string
  /** ワークフローの名前。CircleCI で複数あるときは `, ` でつないである。 */
  workflow: string
  branch: string
  /** コミットの短い SHA。 */
  sha: string
  /** 起動のきっかけ（`push` など）。CircleCI は空。 */
  event: string
  state: CiState
  createdAt: string
  /** CI のページ。CircleCI でワークフローがまだ無い run は null。 */
  url: string | null
  /**
   * 再実行で CLI に渡す id（空なら再実行できない）。単位が CI で違う（GitHub は run、CircleCI は
   * ワークフロー）ので、Rust が決めて運ぶ。
   */
  rerunIds: string[]
  /** 失敗した job だけを再実行するときの id。 */
  rerunFailedIds: string[]
  /** 失敗のログを取るコマンド（エージェントへの指示文に添える）。 */
  failureLogCommand: string
}

/** run の中の job 1 つ（行を開いたときに取る）。 */
export interface CiJob {
  id: string
  name: string
  /** CircleCI のワークフロー名。GitHub は空。 */
  group: string
  state: CiState
  url: string | null
}

export interface CiListResult {
  runs: CiRun[]
  /** 未認証・権限なしの理由。0 件と区別するために出す（実行した行込み）。 */
  error: string | null
}

/** リポジトリがどの CI の設定を持つか。Rust の `CiConfigs`。 */
export type CiConfigs = Record<CiProvider, boolean>

/** run に対する、状態を変える操作。Rust の `CiAction`。 */
export type CiAction = { type: 'rerun'; failedOnly: boolean } | { type: 'cancel' }
