import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * ブラウザのタブ（#368）への通知を、子 webview のラベルで振り分ける（`usePtyRouter` と同じ形）。
 *
 * **タブごとに `listen` しない。** タブのコンポーネントはパーク中の別プロジェクトのぶんも
 * マウントされたままなので、タブごとに張ると通知 1 回につき全タブが起きて、1 つを除いて
 * 捨てることになる。
 *
 * Rust は開いたウィンドウにだけ送る（`emit_to`）ので、受ける側も `getCurrentWindow().listen`
 * にする（素の `listen` は宛先を問わず全ウィンドウで発火する。`project.md` の「マルチウィンドウ」）。
 */

export interface BrowserHandlers {
  /**
   * ページの読み込みが終わった（`url`）か、タイトルが変わった（`title`）。`titleUrl` は
   * そのタイトルが属するページの URL（読み込みの完了より先に届くので、`url` とは別に来る）。
   */
  onState?: (state: { url?: string; title?: string; titleUrl?: string }) => void
  /** ページが新しいウィンドウを開こうとした（`target=_blank` など）。 */
  onNewTab: (url: string) => void
}

const handlers = new Map<string, BrowserHandlers>()
let initialized = false

async function init() {
  if (initialized) return
  initialized = true
  const win = getCurrentWindow()
  await win.listen<{ label: string; url?: string; title?: string; titleUrl?: string }>('browser_state', (event) => {
    const { label, ...state } = event.payload
    handlers.get(label)?.onState?.(state)
  })
  await win.listen<{ label: string; url: string }>('browser_new_tab', (event) => {
    handlers.get(event.payload.label)?.onNewTab(event.payload.url)
  })
}

function register(label: string, h: BrowserHandlers) {
  handlers.set(label, h)
  void init()
}

function unregister(label: string) {
  handlers.delete(label)
}

export const browserRouter = { register, unregister }
