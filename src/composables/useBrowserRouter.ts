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
  /** Jira のページで列の色を変えた（#405）。`colors` は変えた列だけ（消した列は `null`）。 */
  onJiraColors?: (colors: Record<string, string | null>) => void
  /**
   * 次の移動が始まった（#416。Windows だけ。WebView2 の `NavigationStarting`）。
   * `userInitiated` は Pike のアドレス欄・戻る・進む・再読み込みも真。
   */
  onNavigationStarting?: (userInitiated: boolean) => void
  /** ページの中の移動（#416。Windows だけ。WebView2 の `SourceChanged` で新しい文書でないもの）。 */
  onSameDocument?: (url: string) => void
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
  await win.listen<{ label: string; colors: Record<string, string | null> }>('browser_jira_colors', (event) => {
    handlers.get(event.payload.label)?.onJiraColors?.(event.payload.colors)
  })
  await win.listen<{ label: string; userInitiated: boolean }>('browser_navigation_starting', (event) => {
    handlers.get(event.payload.label)?.onNavigationStarting?.(event.payload.userInitiated)
  })
  await win.listen<{ label: string; url: string }>('browser_same_document', (event) => {
    handlers.get(event.payload.label)?.onSameDocument?.(event.payload.url)
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
