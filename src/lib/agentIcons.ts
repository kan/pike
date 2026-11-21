/**
 * エージェント → アイコン（#633。`lib/shellIcons.ts` と同じ形）。今動いているセッションの一覧の見出しが
 * エージェントの名前を文字の代わりに出すのに使う。`Record<AgentId, …>` なので、表（`lib/agents.ts` の
 * `AGENTS`）にエージェントを足すと型エラーで気付く。
 *
 * `lib/agents.ts` から分けてあるのは、あちらを Node のテストから読むため（lucide は Vue を読み込む。
 * `lib/liveSessionIcons.ts` と同じ理由）。各社のロゴは lucide に無いので、形の近い汎用のアイコンを充てる。
 */
import { Asterisk, Bot, Code, Hexagon } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { AgentId } from './agents'

export const AGENT_ICONS: Record<AgentId, Component> = {
  claude: Asterisk,
  codex: Hexagon,
  copilot: Bot,
  opencode: Code,
}
