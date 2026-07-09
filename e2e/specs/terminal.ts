import {
  feedActiveTerminal,
  MATRIX,
  mockInvoke,
  mockPtySpawnUniqueIds,
  openTerminal,
  prepare,
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
      await mockInvoke('pty_resize', null)
      await mockInvoke('pty_write', null)
      await mockInvoke('pty_kill', null)

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
