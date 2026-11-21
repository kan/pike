import {
  addTerminals,
  MATRIX,
  mockInvoke,
  mockPtySpawnUniqueIds,
  openPanel,
  prepare,
  setAgentRuns,
  setFakeProject,
  shoot,
} from '../support/prepare'

// エージェントのセッション一覧（#625）。左にパネル（簡易表示）、右に詳細のタブを開いた 1 枚。
const FULL = { width: 1600, height: 1000 }

const MIN = 60 * 1000

/**
 * 3 つの状態を全部写す。**時刻は撮る時点からの相対で置く**（固定の日時だと、撮るたびに
 * 「n 分前」が変わり、いつか日付の表記になる）。1 件目はこのウィンドウのターミナルで動いて
 * いるもの（行にターミナルの印が付く）、最後は登録済みのプロジェクトに当たらないもの。
 */
function sessions(now: number) {
  const base = {
    // 起動時刻は時計の表記で出るので、撮るたびに変わらないよう固定の日時にする（今日でなければ
    // 日付つきで出る。撮影は日本時間で走る）。
    startedAt: Date.parse('2026-11-18T09:12:00+09:00'),
    version: '2.1.327',
    waitingFor: null,
  }
  return [
    {
      ...base,
      pid: 18420,
      sessionId: '6f2c1a0e-4b7d-4e1a-9c3b-2d8e5f7a1b90',
      cwd: 'C:\\Users\\dev\\demo-app',
      name: 'demo-app-3f',
      status: 'waiting',
      waitingFor: 'permission to run Bash',
      statusSince: now - 2 * MIN,
      title: 'ログイン画面のバリデーションを直す',
      gitBranch: 'fix/login-validation',
    },
    {
      ...base,
      pid: 21904,
      sessionId: '0b9d4e2f-8a1c-4f3e-b6d7-5c2a9e8f1d34',
      cwd: 'C:\\Users\\dev\\demo-app\\.claude\\worktrees\\search',
      name: 'search-a1',
      status: 'busy',
      statusSince: now - 1 * MIN,
      title: '検索 API にページングを足す',
      gitBranch: 'feature/search-paging',
    },
    {
      ...base,
      pid: 9832,
      sessionId: 'c4e8a2b6-1d3f-4a5c-8e7b-9f0d2c6a4e18',
      cwd: 'C:\\Users\\dev\\docs-site',
      name: 'docs-site-7c',
      status: 'idle',
      statusSince: now - 25 * MIN,
      title: 'リリースノートの下書き',
      gitBranch: 'main',
    },
    {
      ...base,
      pid: 30116,
      sessionId: '9a1f3c5e-7b2d-4c8a-a6e4-1d9b0f2c7e53',
      cwd: 'C:\\Users\\dev\\scratch',
      name: 'scratch-12',
      status: 'idle',
      statusSince: now - 95 * MIN,
      title: null,
      gitBranch: null,
    },
  ]
}

describe('screenshots: agent sessions', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-sessions ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...FULL })
      await mockPtySpawnUniqueIds()
      // アカウントごとの一覧の配列（#633。`LiveSessionList[]`）。1 つだけなので見出しは出ない。
      // `shell` は擬似プロジェクトとターミナルのタブと同じにする（行とタブの突き合わせに使う）
      await mockInvoke('agent_live_sessions', [
        {
          agent: 'claude',
          shell: { kind: 'powershell' },
          configDir: 'C:\\Users\\dev\\.claude',
          configOverride: null,
          account: 'dev@example.com',
          current: true,
          sessions: sessions(Date.now()),
        },
      ])
      await setFakeProject()
      await addTerminals(['claude'])
      await setAgentRuns([
        { run: { agent: 'claude', phase: 'waiting', sessionId: '6f2c1a0e-4b7d-4e1a-9c3b-2d8e5f7a1b90' } },
      ])
      await openPanel('sessions')
      await $('[data-testid="sessions-panel"] .session-row').waitForDisplayed({ timeout: 10_000 })
      await $('[data-testid="sessions-open-tab"]').click()
      await $('.agent-sessions .row').waitForDisplayed({ timeout: 10_000 })
      await browser.execute(() => {
        for (const el of document.querySelectorAll<HTMLElement>('.tab-running .spin')) el.style.animation = 'none'
        // 「〜に更新」は撮った時刻が出るので、撮るたびに画像が変わらないよう固定の文言にする。
        const updated = document.querySelector<HTMLElement>('.agent-sessions .updated')
        if (updated) updated.textContent = updated.textContent?.replace(/\d{1,2}:\d{2}:\d{2}/, '10:24:36') ?? ''
      })
      await shoot('agent-sessions', lang, theme)
    })
  }
})
