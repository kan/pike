import { t } from '../i18n'
import type { CiRun } from '../types/ci'

/**
 * エージェントに渡す「この CI の失敗を調べて直して」の指示文（#457）。
 *
 * **消費者は 2 つ**（ターミナルへ送る側と、クリップボードへ出す側）で、文面をここ 1 つに置く
 * 理由は `lib/issuePrompt.ts` の `issueAgentPrompt` と同じ。文言の正本は i18n キー。
 *
 * **ログの本文は運ばず、取るコマンドを添える**（`run.failureLogCommand`。CLI の行なので Rust が
 * 組む）。ログは長いうえ、送る前に読み返す文面が埋まる。
 */
export function ciAgentPrompt(run: CiRun): string {
  return t('ci.fixPrompt', {
    title: run.title,
    workflow: run.workflow,
    branch: run.branch,
    command: run.failureLogCommand,
  })
}
