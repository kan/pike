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

  // 先行 spec が残したタブ（共有アプリセッションで media.ts の spec.pdf 等が残る）を
  // 閉じ、素のタブ状態から撮影する。clearAllTabs は非同期なので await する。
  await browser.execute(async () => {
    const api = (window as unknown as { __pikeE2E?: { resetTabs?: () => Promise<void> } }).__pikeE2E
    await api?.resetTabs?.()
  })

  await browser.execute(
    (lang, dark) => {
      const api = (window as unknown as {
        __pikeE2E: {
          setLanguage: (l: string) => void
          setDarkMode: (d: boolean) => void
          closeOverlays?: () => void
        }
      }).__pikeE2E
      // 前の it で開いたままの overlay（ProjectSwitcher / QuickOpen / worktree
      // ドロップダウン等）を閉じ、素の状態から撮影する。
      api.closeOverlays?.()
      api.setLanguage(lang)
      api.setDarkMode(dark)
    },
    opts.lang,
    opts.theme === 'dark',
  )

  // 言語とウィンドウの大きさを決めたあとに確かめる（どちらも結果を変えうる）。
  await assertCaptureEnvironment()

  // 擬似 root では実ファイル監視の起動が失敗し、FileTreePanel に
  // 「inotify-tools を入れて」の警告バナーが出る。startError はセッション共有の
  // グローバル状態で、root が同一だと watch(activeRoot) が再発火せず後から潰せない。
  // そのため最初の setFakeProject より前（＝全 it の prepare 時点）で監視開始を
  // モックし、初回起動から成功扱いにして撮影を汚さない。
  await mockInvoke('fs_watch_start', 'e2e-watch')

  // エージェントの検出（#275）。**撮影機に何が入っているかで絵が変わってしまう**ので
  // 固定する: 検出が空だと起動ボタンごと消えるため（`showAgentLaunch` は使える起動行が
  // あることを求める）、素のままだと「ターミナル右上のエージェントボタン」の画像から
  // ボタンが消えうる。2 つ返して「他のエージェント」のあるメニューにしておく。
  await mockInvoke('agent_detect', ['claude', 'codex'])

  await injectStabilizeCss()
  await settle()
}

/**
 * マニュアルの画像を撮る環境の前提（#466）。**どれも撮影機の側で決まり、リポジトリからは
 * 固定できない**ので、食い違っていたら撮る前に落とす（気付かずに撮ると、見た目の違う画像が
 * 既存の画像に混ざる）。
 *
 * - `dpr` … 画像は CSS ピクセルに表示倍率を掛けた大きさで保存される（1266×796 の内寸が
 *   1899×1194 px）。倍率の違うモニタにウィンドウが出ると、画像の大きさごと変わる
 * - `uiFont` … UI は `system-ui` なので、OS の表示言語とフォントの入り方で変わる。日本語の
 *   Windows では Yu Gothic UI。漢字が中国語のフォント（Microsoft YaHei など）で描かれると、
 *   字形も字幅も実際の画面と違う絵になる
 * - `monoFont` … エディタとターミナルの既定の先頭（`stores/settings.ts` の `defaults()`）。
 *   Pike は同梱しないので、入っていなければ次の候補で描かれる
 * - `uiZoom` … UI の文字サイズは全体の拡大率として効く（既定の 13px で 1）。撮影用の
 *   プロファイルに設定が残っていると、文字の大きさごと変わる
 *
 * **`prepare()` のたびに確かめる**（1 回の `execute` で済む）。ウィンドウは大きさを変えると
 * 倍率の違うモニタへ移りうるので、最初の 1 回だけでは `FULL` / `HERO` の撮影を見逃す。
 */
const CAPTURE_ENV = { dpr: 1.5, uiFont: 'Yu Gothic UI', monoFont: 'PlemolJP Console NF', uiZoom: 1 }

/** 前提を確かめずに撮る（別の環境で spec の動作だけ確かめたいとき）。画像は同期しないこと。 */
const SKIP_ENV_CHECK = process.env.PIKE_E2E_ANY_ENV === '1'

/** 同じ警告を `prepare()` のたびに出さない（`SKIP_ENV_CHECK` のとき）。 */
let warnedCaptureEnvironment = false

async function assertCaptureEnvironment(): Promise<void> {
  const problems = await browser.execute((env) => {
    // 「どのフォントで描かれたか」を読む API は無いので、同じ文の幅を比べる。**半角と全角を
    // 混ぜる**: 全角だけだと、全角幅のフォントがどれも同じ幅になって見分けられない。
    const TEXT = 'Pike mmmiii 0123 設定の同期、言語を直接確認する（終了）。エージェント'
    const widthOf = (family: string) => {
      const el = document.createElement('span')
      el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:40px;font-family:${family}`
      el.textContent = TEXT
      document.body.append(el)
      const width = el.getBoundingClientRect().width
      el.remove()
      return width
    }
    // 入っているフォントは、後ろに何を並べても同じ幅で描かれる。入っていなければ後ろの
    // 総称フォントに落ちるので、総称を変えると幅が変わる。**「存在しない名前と違う幅か」で
    // 見ないこと**: 既定のフォントが調べたいフォントと同じ幅だと、入っているのに外れる。
    const installed = (name: string) => widthOf(`"${name}", monospace`) === widthOf(`"${name}", serif`)
    const out: string[] = []
    if (widthOf('monospace') === widthOf('serif')) out.push('総称フォントの幅が同じで、フォントの有無を見分けられない')
    if (window.devicePixelRatio !== env.dpr) {
      out.push(`表示倍率が ${env.dpr} ではない（devicePixelRatio = ${window.devicePixelRatio}）`)
    }
    const ui = getComputedStyle(document.body).fontFamily
    if (!installed(env.uiFont) || widthOf(ui) !== widthOf(`"${env.uiFont}"`)) {
      out.push(`UI（${ui}）が ${env.uiFont} で描かれていない`)
    }
    if (!installed(env.monoFont)) out.push(`${env.monoFont} が入っていない`)
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
    if (zoom !== env.uiZoom) out.push(`UI の拡大率が ${env.uiZoom} ではない（--ui-zoom = ${zoom}）`)
    return out
  }, CAPTURE_ENV)
  if (problems.length === 0) return
  const message = `撮影環境が前提と違う（e2e/README.md の「撮影環境の前提」）: ${problems.join(' / ')}`
  if (!SKIP_ENV_CHECK) throw new Error(message)
  if (!warnedCaptureEnvironment) console.warn(`[e2e] ${message}`)
  warnedCaptureEnvironment = true
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
/** `remoteUrl` を渡すのは issue パネルだけ（既定で付けると StatusBar の撮影が変わる）。 */
export async function setFakeProject(opts?: { remoteUrl?: string; root?: string }): Promise<void> {
  await browser.execute((o) => {
    ;(
      window as unknown as {
        __pikeE2E?: { setFakeProject?: (o?: { remoteUrl?: string; root?: string }) => void }
      }
    ).__pikeE2E?.setFakeProject?.(o)
  }, opts)
}

// エージェント状態タブを開く。集計は 30 秒ポーリング + 外部 CLI 依存なので、
// invoke は待たずにストアへ決定的な値を差す。
export async function openAgentStatus(opts: Record<string, unknown>): Promise<void> {
  await browser.execute((o) => {
    ;(
      window as unknown as { __pikeE2E?: { openAgentStatus?: (o: unknown) => void } }
    ).__pikeE2E?.openAgentStatus?.(o)
  }, opts)
}

// ファイルツリーの git ステータス色を撮るため、gitStore.status を直接セットする。
export async function setGitStatus(status: unknown): Promise<void> {
  await browser.execute((s) => {
    ;(window as unknown as { __pikeE2E?: { setGitStatus?: (s: unknown) => void } }).__pikeE2E?.setGitStatus?.(s)
  }, status)
}

// サイドバーの指定パネルを開く。
export async function openPanel(name: string): Promise<void> {
  await browser.execute((n) => {
    ;(window as unknown as { __pikeE2E?: { openPanel?: (n: string) => void } }).__pikeE2E?.openPanel?.(n)
  }, name)
}

// QuickOpen（Ctrl+P）を開く。list_project_files 等のモックは呼ぶ前に設定する。
export async function openQuickOpen(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { openQuickOpen?: () => void } }).__pikeE2E?.openQuickOpen?.()
  })
}

// worktree 一覧を読み込む（git_worktree_list モック前提）。2 件以上で StatusBar に
// セレクタが出る。
export async function loadWorktrees(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { loadWorktrees?: () => void } }).__pikeE2E?.loadWorktrees?.()
  })
}

// 決定的な内容でエディタタブを 1 枚開く（fs_read_file 不要。initialContent 経路）。
// viewMode は markdown 等プレビュー可能な拡張子でのみ効く。
export async function openEditor(opts: {
  path: string
  content: string
  viewMode?: 'edit' | 'split' | 'preview'
}): Promise<void> {
  await browser.execute((o) => {
    ;(
      window as unknown as {
        __pikeE2E?: { openEditor?: (o: unknown) => void }
      }
    ).__pikeE2E?.openEditor?.(o)
  }, opts)
}

// グローバルモードへ入る（サイドバー非表示。WSL 検出でシェルプロファイルを揃える）。
export async function enterGlobalMode(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { enterGlobalMode?: () => void } }).__pikeE2E?.enterGlobalMode?.()
  })
  // globalMode の非同期 WSL 検出とサイドバー消失の描画が落ち着くのを待つ。
  await browser.pause(400)
}

// 複数ファイルを 1 ファイル 1 タブで開く（グローバルモードのエディタ撮影用）。
export async function openEditors(files: { path: string; content: string }[]): Promise<void> {
  await browser.execute((f) => {
    ;(window as unknown as { __pikeE2E?: { openEditors?: (f: unknown) => void } }).__pikeE2E?.openEditors?.(f)
  }, files)
}

// 画像ビューワ（PreviewTab）を dataUrl 直指定で開く（fs_read_file_base64 不要）。
export async function openImage(opts: { path: string; dataUrl: string }): Promise<void> {
  await browser.execute((o) => {
    ;(window as unknown as { __pikeE2E?: { openImage?: (o: unknown) => void } }).__pikeE2E?.openImage?.(o)
  }, opts)
}

// 差分タブ（DiffTab）を unified diff 文字列直指定で開く（invoke 不要）。
export async function openDiff(opts: { filePath: string; diff: string }): Promise<void> {
  await browser.execute((o) => {
    ;(window as unknown as { __pikeE2E?: { openDiff?: (o: unknown) => void } }).__pikeE2E?.openDiff?.(o)
  }, opts)
}

// ファイル履歴タブ（HistoryTab）を開く（git_log_file モック前提）。
export async function openHistory(opts: { filePath: string }): Promise<void> {
  await browser.execute((o) => {
    ;(window as unknown as { __pikeE2E?: { openHistory?: (o: unknown) => void } }).__pikeE2E?.openHistory?.(o)
  }, opts)
}

// PDF タブ（PdfTab）を開く（fs_read_file_base64 モック前提）。
export async function openPdf(opts: { path: string }): Promise<void> {
  await browser.execute((o) => {
    ;(window as unknown as { __pikeE2E?: { openPdf?: (o: unknown) => void } }).__pikeE2E?.openPdf?.(o)
  }, opts)
}

// エージェントが動いているターミナルを並べる（#437。pty_spawn はモック前提）。
// **`setAgentRuns` は状態タブを開いたあとに呼ぶ**（入力待ちの印は、タブを選ぶと下りる）。
export async function addTerminals(titles: string[]): Promise<void> {
  await browser.execute((t) => {
    ;(window as unknown as { __pikeE2E?: { addTerminals?: (t: string[]) => void } }).__pikeE2E?.addTerminals?.(t)
  }, titles)
}

export async function setAgentRuns(runs: Array<{ run: unknown; awaiting?: boolean }>): Promise<void> {
  await browser.execute((r) => {
    ;(window as unknown as { __pikeE2E?: { setAgentRuns?: (r: unknown) => void } }).__pikeE2E?.setAgentRuns?.(r)
  }, runs)
}

// ターミナルタブを 1 枚開く（pty_spawn はモック前提。実プロセスは起動しない）。
export async function openTerminal(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { openTerminal?: () => void } }).__pikeE2E?.openTerminal?.()
  })
}

/**
 * ホバーで開く UI（エージェントのサブメニュー、#267）を開く。
 *
 * **`moveTo()` は使えない。** 撮影ウィンドウの DPR が 1 でないと、ドライバが動かす座標と
 * webview の CSS ピクセルが食い違い、要素の中心へ動かしたつもりが別の場所を指す（DPR 2 の
 * 環境での実測: 1280px のウィンドウで `innerWidth` は 627。今の撮影機は DPR 1.5、#466）。
 * 撮りたいのは開いた状態なので、DOM のイベントを直接投げる。
 */
export async function hoverElement(selector: string): Promise<void> {
  await browser.execute((sel) => {
    const el = document.querySelector(sel)
    el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    el?.dispatchEvent(new MouseEvent('mouseenter'))
  }, selector)
}

// いま見ているタブを右のペインへ送る（そこで作業領域が 2 分割される。#308）。
export async function moveActiveTabRight(): Promise<void> {
  await browser.execute(() => {
    ;(window as unknown as { __pikeE2E?: { moveActiveTabRight?: () => void } }).__pikeE2E?.moveActiveTabRight?.()
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

// PTY 系の invoke を一式モックして、実プロセスを起動させずにターミナルを撮れるようにする。
// `pty_spawn` は呼ばれるたびユニークな id を返す（id 固定だと閉じたタブの unregister が
// 新タブのハンドラを消す）。**残り 3 つとセットで置く**: 分けていたころは 3 spec が同じ
// 4 行を書き写していて、PTY のコマンドが増えるたびに直す場所が 3 つになっていた。
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
  await Promise.all([mockInvoke('pty_resize', null), mockInvoke('pty_write', null), mockInvoke('pty_kill', null)])
}

export const MATRIX: Array<{ lang: Lang; theme: Theme }> = [
  { lang: 'ja', theme: 'light' },
  { lang: 'ja', theme: 'dark' },
  { lang: 'en', theme: 'light' },
  { lang: 'en', theme: 'dark' },
]
