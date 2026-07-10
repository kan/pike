import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const shotDir = path.resolve(here, '..', '..', 'artifacts', 'screenshots')

export type Lang = 'ja' | 'en'
export type Theme = 'light' | 'dark'

export interface PrepareOptions {
  lang: Lang
  theme: Theme
  width?: number
  height?: number
}

// 撮影の再現性を固定する。言語・テーマは e2e ビルドが露出する window.__pikeE2E
// 経由でリロードなしに切り替える（reload 方式は wdio プラグインの runtime
// capability を失効させ警告が氾濫するため）。アニメーション・トランジション・
// キャレット点滅は撮影差分の元になるので CSS で無効化する。
export async function prepare(opts: PrepareOptions): Promise<void> {
  const width = opts.width ?? 1280
  const height = opts.height ?? 832

  await browser.setWindowSize(width, height)

  await $('#app').waitForExist({ timeout: 30_000 })

  // e2e 制御 API が生えるまで待つ（mount 後に露出される）。
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof (window as unknown as { __pikeE2E?: unknown }).__pikeE2E !== 'undefined',
      )) === true,
    { timeout: 30_000, timeoutMsg: '__pikeE2E control API not exposed' },
  )

  await browser.execute(
    (lang, dark) => {
      const api = (window as unknown as {
        __pikeE2E: { setLanguage: (l: string) => void; setDarkMode: (d: boolean) => void }
      }).__pikeE2E
      api.setLanguage(lang)
      api.setDarkMode(dark)
    },
    opts.lang,
    opts.theme === 'dark',
  )

  // 擬似 root では実ファイル監視の起動が失敗し、FileTreePanel に
  // 「inotify-tools を入れて」の警告バナーが出る。startError はセッション共有の
  // グローバル状態で、root が同一だと watch(activeRoot) が再発火せず後から潰せない。
  // そのため最初の setFakeProject より前（＝全 it の prepare 時点）で監視開始を
  // モックし、初回起動から成功扱いにして撮影を汚さない。
  await mockInvoke('fs_watch_start', 'e2e-watch')

  await injectStabilizeCss()
  await settle()
}

// アニメーション・トランジション・キャレット点滅を止める撮影用スタイル。
async function injectStabilizeCss(): Promise<void> {
  await browser.execute(() => {
    const id = 'wdio-screenshot-stabilize'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`
    document.head.appendChild(style)
  })
}

// フォント読み込み完了と描画の安定を待つ。
async function settle(): Promise<void> {
  await browser.execute(async () => {
    if (document.fonts?.ready) await document.fonts.ready
  })
  await browser.pause(300)
}

export async function shoot(name: string, lang: Lang, theme: Theme): Promise<void> {
  await settle()
  await browser.saveScreenshot(path.join(shotDir, `${name}-${lang}-${theme}.png`))
}

// e2e ビルドが露出する window.__pikeE2E の副作用なしナビゲーション helper を呼ぶ。
export async function callE2E(
  method: 'openSwitcher' | 'closeSwitcher' | 'openSettings' | 'enterGlobalMode',
): Promise<void> {
  await browser.execute((m) => {
    const api = (window as unknown as { __pikeE2E?: Record<string, () => void> }).__pikeE2E
    api?.[m]?.()
  }, method)
}

// Tauri invoke をモックする（@wdio/tauri-service）。パネルへ決定的データを与える。
export async function mockInvoke(command: string, value: unknown): Promise<void> {
  const b = browser as unknown as {
    tauri: { mock: (c: string) => Promise<{ mockResolvedValue: (v: unknown) => Promise<void> }> }
  }
  const m = await b.tauri.mock(command)
  await m.mockResolvedValue(value)
}

// 擬似プロジェクトを差して activeRoot を確定させ、invoke 駆動パネルを有効化する。
export async function setFakeProject(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { setFakeProject?: () => void } }).__pikeE2E?.setFakeProject?.()
  })
}

// サイドバーの指定パネルを開く。
export async function openPanel(name: string): Promise<void> {
  await browser.execute((n) => {
    ;(window as unknown as { __pikeE2E?: { openPanel?: (n: string) => void } }).__pikeE2E?.openPanel?.(n)
  }, name)
}

// ターミナルタブを 1 枚開く（pty_spawn はモック前提。実プロセスは起動しない）。
export async function openTerminal(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { openTerminal?: () => void } }).__pikeE2E?.openTerminal?.()
  })
}

// pty_output と同じ経路でアクティブなターミナルへ合成出力を流す。
export async function feedActiveTerminal(data: string): Promise<void> {
  await browser.execute((d) => {
    ;(window as unknown as { __pikeE2E?: { feedActiveTerminal?: (d: string) => void } }).__pikeE2E?.feedActiveTerminal?.(
      d,
    )
  }, data)
}

// pty_spawn をモックし、呼ばれるたびユニークな id を返す。id 固定だと閉じたタブの
// unregister が新タブのハンドラを消してしまうため。
export async function mockPtySpawnUniqueIds(): Promise<void> {
  const b = browser as unknown as {
    tauri: { mock: (c: string) => Promise<{ mockImplementation: (f: () => unknown) => Promise<void> }> }
  }
  const m = await b.tauri.mock('pty_spawn')
  await m.mockImplementation(() => {
    const w = window as unknown as { __ptyN?: number }
    w.__ptyN = (w.__ptyN ?? 0) + 1
    return { id: `e2e-term-${w.__ptyN}` }
  })
}

export const MATRIX: Array<{ lang: Lang; theme: Theme }> = [
  { lang: 'ja', theme: 'light' },
  { lang: 'ja', theme: 'dark' },
  { lang: 'en', theme: 'light' },
  { lang: 'en', theme: 'dark' },
]
