/**
 * エージェント → アイコン（#633。`lib/shellIcons.ts` と同じ形）。今動いているセッションの一覧の見出しが
 * エージェントの名前を文字の代わりに出すのに使う。`Record<AgentId, …>` なので、表（`lib/agents.ts` の
 * `AGENTS`）にエージェントを足すと型エラーで気付く。
 *
 * `lib/agents.ts` から分けてあるのは、あちらを Node のテストから読むため（lucide は Vue を読み込む。
 * `lib/liveSessionIcons.ts` と同じ理由）。
 *
 * **ロゴがあるものはロゴ**（`lib/brandIcons.ts`。Simple Icons の CC0 のものだけを写す）。無いものは lucide の
 * 汎用のアイコンのまま:
 * - Codex：OpenAI のロゴは Simple Icons に収録されていない（取り下げられている）
 * - Copilot CLI：GitHub Copilot のロゴは Simple Icons では MIT で、表記の義務があるので写していない
 */
import { Bot, Hexagon } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { AgentId } from './agents'
import { ClaudeLogo, OpenCodeLogo } from './brandIcons'

export const AGENT_ICONS: Record<AgentId, Component> = {
  claude: ClaudeLogo,
  codex: Hexagon,
  copilot: Bot,
  opencode: OpenCodeLogo,
}
