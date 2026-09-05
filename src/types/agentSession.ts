/**
 * 起動メニューの再開一覧の 1 件（#220 / #267）。
 *
 * **種別に依らない形**。出所は 4 つとも違うが（`agent_sessions` の doc が正本）、選ぶために
 * 要る情報は同じなので、型を分けない。再開コマンドは `lib/agents.ts` の `resume` が組む。
 */
export interface AgentSession {
  /** 再開コマンドに渡す id。 */
  id: string
  /** 一覧に出す名前。取れなければ空文字（呼ぶ側が id で代替する）。 */
  title: string
  /** 最終更新（epoch ms）。 */
  modifiedAt: number
  /** 当時のブランチ。取れないエージェントでは null。 */
  gitBranch: string | null
}
