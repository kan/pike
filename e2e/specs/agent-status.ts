import { MATRIX, openAgentStatus, prepare, setFakeProject, shoot } from '../support/prepare'

// カードを 1 画面に収めるため、既定より縦を取る（layout.ts と同じ）。
const FULL = { width: 1600, height: 1260 }

// エージェント状態タブ（#226 / #263）を撮影する。
// 集計は 30 秒ポーリング + 外部 CLI（`claude -p "/usage"` / `~/.codex` の走査 /
// `opencode db`）に依存するので、invoke は待たずにストアへ決定的な値を直接差す。
//
// **形は `AgentUsage` 1 つ**（#263 でアダプタに分けたので、種別ごとの型はもう無い）。
// 4 つで取れるものが揃わないことを撮るために、**わざと違う埋まり方**にしてある:
// Claude はモデル別＋利用率、Codex は合計＋利用率、Copilot は premium request だけ、
// opencode はトークンと費用だけ。

const CLAUDE = {
  id: 'claude',
  active: true,
  account: { email: 'dev@example.com', plan: 'claude_max_20x', organization: 'Example Inc' },
  meters: [
    { kind: 'session' as const, label: 'session', usedPercent: 34, resetsAt: 'Aug 13, 2:50am (Asia/Tokyo)' },
    { kind: 'weekAll' as const, label: 'week (all models)', usedPercent: 61, resetsAt: 'Aug 16, 6pm (Asia/Tokyo)' },
  ],
  total: {
    label: null,
    input: 6_060,
    output: 351_830,
    cacheRead: 12_484_000,
    cacheWrite: 214_200,
    reasoning: 0,
    costUsd: 18.73,
  },
  rows: [
    {
      label: 'claude-opus-5',
      input: 4_820,
      output: 341_960,
      cacheRead: 12_400_000,
      cacheWrite: 208_000,
      reasoning: 0,
      costUsd: 18.42,
    },
    {
      label: 'claude-haiku-4-5',
      input: 1_240,
      output: 9_870,
      cacheRead: 84_000,
      cacheWrite: 6_200,
      reasoning: 0,
      costUsd: 0.31,
    },
  ],
  facts: [],
  fetchedAt: 1_786_500_000,
}

const CODEX = {
  id: 'codex',
  active: false,
  account: { email: 'dev@example.com', plan: 'plus', organization: null },
  meters: [
    { kind: 'session' as const, label: null, usedPercent: 12, resetsAt: null },
    { kind: 'weekAll' as const, label: null, usedPercent: 47, resetsAt: null },
  ],
  total: {
    label: 'gpt-5.4-codex',
    input: 128_400,
    output: 22_780,
    cacheRead: 96_100,
    cacheWrite: 0,
    reasoning: 14_320,
    costUsd: null,
  },
  rows: [],
  facts: [
    { key: 'session-count' as const, value: '3' },
    { key: 'last-activity' as const, value: String(Math.floor(Date.now() / 1000) - 3 * 60 * 60) },
    { key: 'auth-mode' as const, value: 'chatgpt' },
  ],
  fetchedAt: 1_786_500_000,
}

// Copilot は premium request（AI クレジット）しか取れない。トークンも利用率も無い。
const COPILOT = {
  id: 'copilot',
  active: false,
  account: null,
  meters: [],
  total: null,
  rows: [],
  facts: [
    { key: 'session-count' as const, value: '2' },
    { key: 'premium-requests' as const, value: '1.32' },
    { key: 'last-activity' as const, value: String(Math.floor(Date.now() / 1000) - 40 * 60) },
  ],
  fetchedAt: 1_786_500_000,
}

// opencode は BYOK なので利用率が無く、トークンと費用だけ。
const OPENCODE = {
  id: 'opencode',
  active: true,
  account: null,
  meters: [],
  total: {
    label: 'anthropic/claude-sonnet-5',
    input: 41_200,
    output: 8_940,
    cacheRead: 310_000,
    cacheWrite: 22_100,
    reasoning: 0,
    costUsd: 1.24,
  },
  rows: [],
  facts: [{ key: 'session-count' as const, value: '5' }],
  fetchedAt: 1_786_500_000,
}

describe('screenshots: agent status', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-status ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...FULL })
      await setFakeProject()
      await openAgentStatus({ claude: CLAUDE, codex: CODEX, copilot: COPILOT, opencode: OPENCODE })
      await $('.agent-status').waitForDisplayed({ timeout: 10_000 })
      await shoot('agent-status', lang, theme)
    })
  }
})
