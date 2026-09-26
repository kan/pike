import { t } from '../i18n'
import type { IssueKind } from '../types/issues'

/**
 * 一覧の種類（issue / PR、#413）ごとの文言の i18n キー。**種類で変わる文言はここだけに置く**:
 * パネルの行・右クリックメニュー・空表示と issue タブが引く。呼び出し側に `isPr ? a : b` を
 * 散らすと、文言を足したときに 1 箇所漏れて「PR なのに着手」が出る。
 */
export const ISSUE_KIND_TEXT = {
  issue: {
    prompt: 'issues.startPrompt',
    action: 'issues.startWork',
    copy: 'issues.copyStartPrompt',
    empty: 'issues.empty',
    noMatch: 'issues.noMatch',
  },
  pr: {
    prompt: 'issues.reviewPrompt',
    action: 'issues.review',
    copy: 'issues.copyReviewPrompt',
    empty: 'issues.emptyPulls',
    noMatch: 'issues.noMatchPulls',
  },
} as const satisfies Record<IssueKind, Record<string, string>>

/**
 * エージェントに渡す指示文（#336）。issue は「この issue に着手して」、PR（#413）は
 * 「マージしたいのでレビューして」。
 *
 * **消費者は 2 つで、経路が違う**: ターミナルへ送る側（`composables/useTerminalInject.ts` の
 * `injectIssuePrompt`）と、クリップボードへ出す側（issue パネルの右クリックメニュー）。後者は
 * **文字列の流し込みが効かないエージェント向けの逃げ道**で、同じ文面を人が自分で貼れるように
 * してある。文面をここ 1 つに置くのは、片方だけ古くなるのを防ぐため。
 *
 * 文言そのものの正本は i18n キー（UI 言語に従う。`diagnostics.fixPrompt` と同じ扱い）。
 * **本文は運ばない**: 番号を渡せばエージェントが `gh issue view` / `gh pr diff` で取れるうえ、
 * 長い本文を貼ると、送る前に読み返す文面が埋まる。
 */
export function issueAgentPrompt(kind: IssueKind, number: number, title: string): string {
  return t(ISSUE_KIND_TEXT[kind].prompt, { number, title })
}
