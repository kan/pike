import type { AgentId } from '../lib/agents'
import type { ShellType } from './tab'

/**
 * 今動いているエージェントのセッション 1 件（#625 / #633。Rust の `agent_live::LiveSession`）。
 *
 * **再開の一覧（`AgentSession`）とは別物**: あちらは記録から引いた過去のセッションで、
 * こちらは今プロセスが生きているもの（Claude は設定ディレクトリの `sessions/<pid>.json`、
 * Codex は直近に書かれた rollout）。
 */
export interface LiveSession {
  /** プロセスの id。Codex は記録に持たないので無い。 */
  pid: number | null
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
  /** 今の状態になった時刻（epoch ms）。Codex は記録が最後に書かれた時刻。 */
  statusSince: number | null
  version: string | null
  /** 記録から読んだ題（再開のメニューと同じ規則。Codex は `thread_name` が先）。 */
  title: string | null
  gitBranch: string | null
}

/**
 * 返答待ち・稼働中・アイドル（Claude）と、最近（Codex。直近に書かれたが今ターンが動いて
 * いるとは言えないもの）。
 */
export type LiveStatus = 'waiting' | 'busy' | 'idle' | 'recent'

/**
 * 1 つのアカウント（エージェント × 環境 × 設定ディレクトリ）の一覧（Rust の
 * `agent_live::LiveSessionList`）。Rust はこれの配列を返す。
 */
export interface LiveSessionList {
  agent: AgentId
  /** 記録を書いた環境のシェル。飛んだ先でターミナルを開くのもこのシェル。 */
  shell: ShellType
  /** 読んだ設定ディレクトリ（Pike から読める形）。 */
  configDir: string
  /** 再開するときに `CLAUDE_CONFIG_DIR` へ渡す値。既定の `~/.claude` なら無い。 */
  configOverride: string | null
  account: string | null
  /** 今のプロジェクトのアカウントか（セッションが無くても返る、ただ 1 つの一覧）。 */
  current: boolean
  sessions: LiveSession[]
}
