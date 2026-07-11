import { type AgentChatFixture, MATRIX, openAgentChat, prepare, setFakeProject, shoot } from '../support/prepare'
import type { Lang } from '../support/prepare'

// エージェントチャット（Codex / Claude Code）を撮影する。
// 実セッション（agent_start_session 等）は起動せず、store の session 状態を
// 決定的な会話で直接構築する（openAgentChat ヘルパー）。connected=true を先に
// 立てておくため AgentChatTab.onMounted の自動接続はスキップされ、backend 非依存。

type Msg = AgentChatFixture['messages'][number]

// 会話メッセージを組み立てる小さなビルダ。agent メッセージは text と item を
// 時系列 segment として並べる（AgentChatTab は segments を描画する）。
function userMsg(id: string, text: string): Msg {
  return { id, role: 'user', text, segments: [], items: [], completed: true }
}

interface Seg {
  kind: 'text' | 'item'
  text?: string
  item?: { type: string; id: string; data: Record<string, unknown>; completed: boolean }
}

function agentMsg(id: string, segs: Seg[]): Msg {
  const items = segs.filter((s) => s.kind === 'item').map((s) => s.item)
  return { id, role: 'agent', text: '', segments: segs, items, completed: true }
}

function text(t: string): Seg {
  return { kind: 'text', text: t }
}
function command(id: string, cmd: string, output: string, exitCode: number): Seg {
  return { kind: 'item', item: { type: 'commandExecution', id, completed: true, data: { command: cmd, output, exitCode } } }
}
function fileChange(id: string, filePath: string, additions: number, deletions: number): Seg {
  return {
    kind: 'item',
    item: { type: 'fileChange', id, completed: true, data: { filePath, additions, deletions, diff: '' } },
  }
}
function reasoning(id: string, summary: string): Seg {
  return { kind: 'item', item: { type: 'reasoning', id, completed: true, data: { summary } } }
}

// --- Codex 会話 -------------------------------------------------------------
const CODEX_CAPS: AgentChatFixture['capabilities'] = {
  displayName: 'Codex',
  supportsModelSelection: true,
  supportsSessionResume: true,
  supportsRollback: true,
  supportsCompact: true,
  supportsSandboxConfig: true,
  supportsApprovalConfig: true,
  supportsAuthFlow: true,
}

const TEST_OUTPUT = [
  'PASS  src/lib/format.test.ts',
  '  formatCost',
  '    ✓ formats dollars and cents (3 ms)',
  '    ✓ shows <$0.01 for tiny amounts (1 ms)',
  '',
  'Tests: 8 passed, 8 total',
].join('\n')

function codexFixture(lang: Lang): AgentChatFixture {
  const ja = lang === 'ja'
  const messages: Msg[] = [
    userMsg(
      'u1',
      ja
        ? 'format.ts の formatCost を、$0.01 未満のとき「<$0.01」と表示するようにして。テストも通して。'
        : 'Update formatCost in format.ts to show "<$0.01" for amounts under one cent, and make the tests pass.',
    ),
    agentMsg('a1', [
      reasoning(
        'r1',
        ja
          ? 'formatCost は toFixed(2) で丸めるため極小コストが $0.00 になる。閾値分岐を足し、既存テストへの影響を確認する。'
          : 'formatCost rounds with toFixed(2), so tiny costs render as $0.00. Add a threshold branch and check the existing tests.',
      ),
      text(
        ja
          ? 'format.ts を確認しました。少額用の分岐を追加してテストを実行します。'
          : "I checked format.ts. I'll add a small-amount branch and run the tests.",
      ),
      command('c1', 'npm test -- format', TEST_OUTPUT, 0),
      fileChange('f1', 'src/lib/format.ts', 3, 1),
      text(
        ja
          ? ['**完了しました。**', '', '- `formatCost` に `usd < 0.01` の分岐を追加', '- 既存テストはすべて green（8 件）', '', '必要なら CHANGELOG にも追記します。'].join('\n')
          : ['**Done.**', '', '- Added a `usd < 0.01` branch to `formatCost`', '- All existing tests are green (8 total)', '', 'I can add a CHANGELOG entry too if you want.'].join('\n'),
      ),
    ]),
  ]
  return {
    agentType: 'codex',
    capabilities: CODEX_CAPS,
    authEmail: 'dev@example.com',
    sessionTitle: ja ? '少額コスト表示の追加' : 'Add small-amount cost display',
    selectedModel: 'gpt-5-codex',
    tokenUsage: { input: 18_432, output: 2_743 },
    detectedInstructionsFile: 'AGENTS.md',
    messages,
  }
}

// --- Claude Code 会話（ACP: model 選択 / sandbox / approval / auth なし） -----
const CLAUDE_CAPS: AgentChatFixture['capabilities'] = {
  displayName: 'Claude Code',
  supportsModelSelection: false,
  supportsSessionResume: true,
  supportsRollback: false,
  supportsCompact: false,
  supportsSandboxConfig: false,
  supportsApprovalConfig: false,
  supportsAuthFlow: false,
}

function claudeFixture(lang: Lang): AgentChatFixture {
  const ja = lang === 'ja'
  const messages: Msg[] = [
    userMsg(
      'u1',
      ja
        ? 'SideBar の Git バッジに、コンフリクト（unmerged）の件数も足したい。'
        : 'Add the conflicted (unmerged) count to the Git badge in SideBar.',
    ),
    agentMsg('a1', [
      reasoning(
        'r1',
        ja
          ? 'バッジ件数は status のダーティ数を数えている。conflicted 配列の長さを加算し、conflicted があるときは danger 色にする。'
          : 'The badge counts dirty entries from status. Add the length of the conflicted array and switch to the danger color when conflicts exist.',
      ),
      text(
        ja
          ? 'SideBar.vue のバッジ算出を確認しました。conflicted 件数を加算します。'
          : "I checked the badge computation in SideBar.vue. I'll add the conflicted count.",
      ),
      fileChange('f1', 'src/components/layout/SideBar.vue', 5, 2),
      text(
        ja
          ? ['変更しました。', '', '- バッジ件数に `conflicted.length` を加算', '- コンフリクト時はバッジを `--danger` 色に切替'].join('\n')
          : ['Updated.', '', '- Added `conflicted.length` to the badge count', '- Switched the badge to the `--danger` color when conflicts exist'].join('\n'),
      ),
    ]),
  ]
  return {
    agentType: 'claude-code',
    capabilities: CLAUDE_CAPS,
    authEmail: null,
    sessionTitle: ja ? 'Git バッジにコンフリクト件数' : 'Conflict count in Git badge',
    selectedModel: null,
    tokenUsage: { input: 12_805, output: 1_960 },
    detectedInstructionsFile: 'CLAUDE.md',
    messages,
  }
}

describe('screenshots: agent chat (Codex)', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-codex ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openAgentChat(codexFixture(lang))
      await $('.msg-agent').waitForDisplayed({ timeout: 10_000 })
      await shoot('agent-codex', lang, theme)
    })
  }
})

describe('screenshots: agent chat (Claude Code)', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-claude ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openAgentChat(claudeFixture(lang))
      await $('.msg-agent').waitForDisplayed({ timeout: 10_000 })
      await shoot('agent-claude', lang, theme)
    })
  }
})
