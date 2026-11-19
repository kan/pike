/**
 * 今動いている Claude Code のセッション 1 件（#625。Rust の `claude_usage::live::LiveSession`）。
 *
 * **再開の一覧（`AgentSession`）とは別物**: あちらは記録から引いた過去のセッションで、
 * こちらは設定ディレクトリの `sessions/<pid>.json` に載っている、今プロセスが生きているもの。
 */
export interface LiveSession {
  pid: number
  sessionId: string
  /** 起動したディレクトリ（そのシェルから見た形。WSL なら `/home/...`）。 */
  cwd: string
  /** Claude Code が付けた名前（`pike-47` など）。 */
  name: string | null
  status: LiveStatus
  /** 待っている理由（`waiting` のときだけ。Claude Code の英語の文言のまま）。 */
  waitingFor: string | null
  /** 起動した時刻（epoch ms）。 */
  startedAt: number | null
  /** 今の状態になった時刻（epoch ms）。 */
  statusSince: number | null
  version: string | null
  /** 記録から読んだ題（再開のメニューと同じ規則）。 */
  title: string | null
  gitBranch: string | null
}

/** 返答待ち・稼働中・アイドルの 3 つ（issue の言うグループ分け）。 */
export type LiveStatus = 'waiting' | 'busy' | 'idle'

/** 一覧と、どのアカウントのものか（Rust の `LiveSessionList`）。 */
export interface LiveSessionList {
  sessions: LiveSession[]
  /** 読んだ設定ディレクトリ（Pike から読める形）。 */
  configDir: string | null
  account: string | null
}
