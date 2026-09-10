import { t } from '../i18n'

/**
 * エージェントに渡す「この issue に着手して」の指示文（#336）。
 *
 * **消費者は 2 つで、経路が違う**: ターミナルへ送る側（`composables/useTerminalInject.ts` の
 * `injectIssueStart`）と、クリップボードへ出す側（issue パネルの右クリックメニュー）。後者は
 * **文字列の流し込みが効かないエージェント向けの逃げ道**で、同じ文面を人が自分で貼れるように
 * してある。文面をここ 1 つに置くのは、片方だけ古くなるのを防ぐため。
 *
 * 文言そのものの正本は i18n キー（UI 言語に従う。`diagnostics.fixPrompt` と同じ扱い）。
 * **本文は運ばない**: 番号を渡せばエージェントが `gh issue view` で取れるうえ、長い本文を
 * 貼ると、送る前に読み返す文面が埋まる。
 */
export function issueStartPrompt(number: number, title: string): string {
  return t('issues.startPrompt', { number, title })
}
