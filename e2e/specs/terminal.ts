import {
  feedActiveTerminal,
  hoverElement,
  MATRIX,
  mockInvoke,
  mockPtySpawnUniqueIds,
  openTerminal,
  prepare,
  setFakeProject,
  shoot,
} from '../support/prepare'

// Phase 2: 実プロセス依存のターミナルを撮影する。pty_spawn をモックして実シェルを
// 起動させず、pty_output と同じ経路（ptyRouter.feed）で決定的な合成出力を xterm に
// 流す。これで機種依存のプロンプトやタイミング差を排して再現性のある撮影ができる。

// ANSI 付きの擬似ターミナルセッション。\x1b[…m は色。
const SESSION = [
  '\x1b[1;32muser@demo\x1b[0m:\x1b[1;34m~/demo-app\x1b[0m$ npm run dev\r\n',
  '\r\n',
  '\x1b[2m> demo-app@0.1.0 dev\x1b[0m\r\n',
  '\x1b[2m> vite\x1b[0m\r\n',
  '\r\n',
  '  \x1b[32m\x1b[1mVITE\x1b[0m \x1b[2mv6.0.0\x1b[0m  ready in \x1b[1m318 ms\x1b[0m\r\n',
  '\r\n',
  '  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:5173/\x1b[0m\r\n',
  '  \x1b[32m➜\x1b[0m  \x1b[1mNetwork\x1b[0m: use \x1b[1m--host\x1b[0m to expose\r\n',
  '\r\n',
  '\x1b[1;32muser@demo\x1b[0m:\x1b[1;34m~/demo-app\x1b[0m$ ',
].join('')

describe('screenshots: terminal', () => {
  for (const { lang, theme } of MATRIX) {
    it(`terminal ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      // 実プロセスを起動させないため PTY 系 invoke をモックする。
      await mockPtySpawnUniqueIds()

      await openTerminal()
      await $('[data-testid="terminal"]').waitForDisplayed({ timeout: 10_000 })
      // xterm の描画とハンドラ登録（spawn 解決後）を待つ。
      await $('.xterm-screen').waitForExist({ timeout: 10_000 })
      await browser.pause(300)

      await feedActiveTerminal(SESSION)
      await shoot('terminal', lang, theme)
    })
  }
})

// --- agent-menu（起動ボタンの ▾ と「最近のセッション」、#275 / #267）----------
// 一覧は agent_sessions が返すものなので、撮影機の実際の履歴に依らないよう固定する。
const SESSIONS = [
  { id: 'a1b2c3d4', title: '設定画面の分類を整理して検索を付ける', modifiedAt: 0, gitBranch: 'main' },
  { id: 'e5f6a7b8', title: 'diff の横スクロールを直す', modifiedAt: 0, gitBranch: 'fix/diff-scroll' },
  { id: 'c9d0e1f2', title: 'issue パネルの sub-issue を木にする', modifiedAt: 0, gitBranch: 'feature/issues' },
]

describe('screenshots: agent menu', () => {
  for (const { lang, theme } of MATRIX) {
    it(`agent-menu ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockPtySpawnUniqueIds()
      // 相対時刻は「いつ撮ったか」で変わるので、撮影のたびに差分が出ないよう固定の
      // 経過時間にする（1 時間前 / 3 時間前 / 昨日）。
      const now = Date.now()
      await mockInvoke(
        'agent_sessions',
        SESSIONS.map((s, i) => ({ ...s, modifiedAt: now - [1, 3, 26][i] * 3600_000 })),
      )

      // 一覧を引く先は「pty_get_cwd → タブの cwd → プロジェクトの root」の順なので、
      // 両方を固定して撮影機の実際の現在地に依らないようにする。
      await mockInvoke('pty_get_cwd', 'C:/Users/dev/demo-app')
      await setFakeProject()

      await openTerminal()
      await $('[data-testid="terminal"]').waitForDisplayed({ timeout: 10_000 })
      await $('.xterm-screen').waitForExist({ timeout: 10_000 })
      await browser.pause(300)
      await feedActiveTerminal(SESSION)

      await $('.agent-btn.caret').click()
      await $('[data-testid="agent-menu"]').waitForDisplayed({ timeout: 10_000 })
      // 「最近のセッション」はホバーで横に開く。取得は開いたときだけ走る。
      await hoverElement('[data-testid="agent-sessions-row"]')
      await $('[data-testid="agent-sessions"]').waitForDisplayed({ timeout: 10_000 })
      await browser.pause(300)
      await shoot('agent-menu', lang, theme)
    })
  }
})
