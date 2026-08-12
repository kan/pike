import { MATRIX, openAgentStatus, prepare, setFakeProject, shoot } from '../support/prepare'

// Claude と Codex の 2 カードを 1 画面に収めるため、既定より縦を取る（layout.ts と同じ）。
const FULL = { width: 1600, height: 1260 }

// エージェント状態タブ（#226）を撮影する。
// 集計は 30 秒ポーリング + 外部 CLI（`claude -p "/usage"` / `~/.codex` の走査）に
// 依存するので、invoke は待たずにストアへ決定的な値を直接差す（agent.ts と同じ方針）。

const CLAUDE_USAGE = {
  active: true,
  sessionId: 'sess-1',
  startedAt: null,
  models: [
    {
      model: 'claude-opus-5',
      inputTokens: 4_820,
      outputTokens: 341_960,
      cacheReadTokens: 12_400_000,
      cacheCreationTokens: 208_000,
      costUsd: 18.42,
    },
    {
      model: 'claude-haiku-4-5',
      inputTokens: 1_240,
      outputTokens: 9_870,
      cacheReadTokens: 84_000,
      cacheCreationTokens: 6_200,
      costUsd: 0.31,
    },
  ],
  totalInputTokens: 6_060,
  totalOutputTokens: 351_830,
  totalCacheReadTokens: 12_484_000,
  totalCacheCreationTokens: 214_200,
  estimatedCostUsd: 18.73,
  account: {
    email: 'dev@example.com',
    displayName: 'Dev',
    organization: 'Example Inc',
    plan: 'claude_max_20x',
  },
  configDir: null,
}

const CLAUDE_RATE = {
  active: true,
  fetchedAt: 1_786_500_000,
  windows: [
    { label: 'session', kind: 'session' as const, usedPercent: 34, resetsAt: 'Aug 13, 2:50am (Asia/Tokyo)' },
    { label: 'week (all models)', kind: 'weekAll' as const, usedPercent: 61, resetsAt: 'Aug 16, 6pm (Asia/Tokyo)' },
  ],
}

const CODEX_USAGE = {
  active: false,
  sessionId: 'codex-1',
  model: 'gpt-5.4-codex',
  sessionCount: 3,
  totalInputTokens: 128_400,
  totalCachedInputTokens: 96_100,
  totalOutputTokens: 22_780,
  totalReasoningTokens: 14_320,
  estimatedCostUsd: null,
  rateLimitPrimary: { usedPercent: 12, windowMinutes: 300, resetsAt: null },
  rateLimitSecondary: { usedPercent: 47, windowMinutes: 10_080, resetsAt: null },
  lastActivityAt: Math.floor(Date.now() / 1000) - 3 * 60 * 60,
  account: { email: 'dev@example.com', plan: 'plus', authMode: 'chatgpt' },
}

describe('screenshots: agent status', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-status ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...FULL })
      await setFakeProject()
      await openAgentStatus({
        claudeUsage: CLAUDE_USAGE,
        claudeRate: CLAUDE_RATE,
        codexUsage: CODEX_USAGE,
      })
      await $('.agent-status').waitForDisplayed({ timeout: 10_000 })
      await shoot('agent-status', lang, theme)
    })
  }
})
