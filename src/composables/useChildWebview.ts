import { computed, onMounted, onUnmounted, type Ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { overlayOpen } from '../lib/overlay'
import { type BrowserBounds, browserClose, browserPlace } from '../lib/tauri'
import { useSidebarStore } from '../stores/sidebar'
import { useTabStore } from '../stores/tabs'
import { type BrowserHandlers, browserRouter } from './useBrowserRouter'

/**
 * 子 webview（`Window::add_child`）を DOM の 1 要素の矩形に重ねて面倒を見る（#399）。
 * ブラウザのタブ（#368、`BrowserTab.vue`）と HTML のプレビュー（#399、`HtmlPreview.vue`）が
 * 共有する。**作る中身だけが呼び出し側の持ち物**で、位置合わせ・隠す・閉じる・作り直しは
 * ここにしか書かない。書き写すと、下の約束を片方だけ直す事故が起きる。
 *
 * - **位置合わせは 1 本ずつ順に送る**（`sync`）。Rust のコマンドは別々のタスクで走るので、
 *   重ねて送ると「見せる」と「隠す」の順が入れ替わり、隠したはずのページが見えたまま残りうる
 * - **変わっていなければ送らない**。リサイズ中は毎フレーム来るうえ、隠れているタブにも
 *   ResizeObserver が届く（大きさが 0 になる通知）
 * - **隠すときはフレームを待たない**。待つと、そのあいだ別のタブの上にページが残る
 * - **手前に浮くものがあるあいだは隠す**（`shown`。子 webview は Pike の DOM より手前に描かれる）
 *
 * **作っている途中（`creating`）を別に持つ**: 作り終える前に位置や表示を送ると相手がいないので
 * 失敗し、隠す指示もそこで失われる。作り終えたら測り直す。
 */
export interface ChildWebviewOptions {
  /** 子 webview を重ねる要素。中身は空で、矩形だけを貸す。 */
  el: Readonly<Ref<HTMLElement | null | undefined>>
  /** 描かれているか（タブが見えていて、置き場の要素が表示されている）。 */
  visible: () => boolean
  /** 新しいラベルを作る。Rust はラベルの接頭辞で相手を確かめる。 */
  newLabel: () => string
  /** まだ作るべきでなければ false（空のブラウザのタブなど）。省略すれば常に作ってよい。 */
  canCreate?: () => boolean
  /**
   * 作る前に、既にある子 webview を受け取れるか試す（ブラウザのタブの #402）。受け取ったら
   * `adopt` を呼んで true を返す。
   */
  beforeCreate?: () => Promise<boolean>
  /** 子 webview を作る。失敗は投げる。 */
  create: (label: string, bounds: BrowserBounds) => Promise<void>
  /** ページからの知らせ（ラベルで振り分けられる）。 */
  handlers: BrowserHandlers
  /** 失敗を知らせる（null は「直った」）。 */
  onError: (e: string | null) => void
  /**
   * 持つ子 webview を差し替えた（`release` / `adopt` / `recreate`）。その子 webview に
   * 結び付けて持っている状態は、ここで捨てる。
   */
  onReset?: () => void
}

/**
 * エディタの Preview に重ねる子 webview（HTML の #399、Vue SFC の #397）に共通の欄。
 * **ラベルは `browser-preview-{uuid}`**（Rust の `html_preview.rs` の `check_label` と対。
 * `browser-` の下なので、位置合わせ・再読み込み・閉じるはブラウザのタブのコマンドを使う）。
 * プレビューの中のリンク（Rust がブラウザのタブへ振り替えたもの）は、同じペインの新しい
 * ブラウザのタブで開く。
 */
export function previewWebviewOptions(tabId: string): Pick<ChildWebviewOptions, 'visible' | 'newLabel' | 'handlers'> {
  const tabStore = useTabStore()
  return {
    visible: () => tabStore.isTabVisible(tabId),
    newLabel: () => `browser-preview-${crypto.randomUUID()}`,
    handlers: {
      onNewTab: (url) => {
        const tab = tabStore.tabs.find((x) => x.id === tabId)
        tabStore.addBrowserTab(url, { forceNew: true, pane: tab ? tabStore.paneOf(tab) : undefined })
      },
    },
  }
}

export function useChildWebview(opts: ChildWebviewOptions) {
  const { t } = useI18n()
  const sidebar = useSidebarStore()

  const canCreate = opts.canCreate ?? (() => true)
  let label = opts.newLabel()
  let state: 'none' | 'creating' | 'ready' = 'none'
  let disposed = false

  /**
   * 重ねてよいか。描かれていて、手前に出るものが 1 つも無く、Git パネルも閉じているとき。
   *
   * **「何が手前にあるか」の出典は `lib/overlay.ts` の 1 つ**（#396）。**Git パネルだけは、
   * 開いているあいだずっと隠す**: コミットの行をなぞるだけでツールチップがパネルの横＝
   * タブの領域に出るので、`useOverlay` に登録すると行をなぞるたびにページが出入りして点滅する。
   */
  const shown = computed(() => opts.visible() && !overlayOpen() && sidebar.activePanel !== 'git')

  /**
   * 隠しているあいだ、その場に出す案内（#396）。**理由で文言を分ける**: Git パネルは
   * 開けっぱなしにできるので、閉じれば戻ることを言わないと戻し方が分からない。
   */
  const hiddenNotice = computed(() => {
    if (!opts.visible() || shown.value) return ''
    return sidebar.activePanel === 'git' ? t('browser.hiddenByPanel') : t('browser.hiddenByOverlay')
  })

  function measure(): BrowserBounds | null {
    const el = opts.el.value
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  /** 位置合わせは 1 フレームに 1 回へ畳む（リサイズ中は ResizeObserver が連続で来る）。 */
  let frame = 0
  function scheduleSync() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      void sync()
    })
  }

  /** 走っている最中に頼まれたら印だけ付け、終わってから最新の状態でもう一度合わせる。 */
  let syncing = false
  let syncAgain = false

  async function sync() {
    if (syncing) {
      syncAgain = true
      return
    }
    syncing = true
    try {
      await syncOnce()
    } finally {
      syncing = false
      if (syncAgain) {
        syncAgain = false
        void sync()
      }
    }
  }

  /** 最後に送った表示と位置（作るときは見えている状態で作る）。 */
  let lastVisible = true
  let lastBoundsKey = ''

  async function syncOnce() {
    if (disposed) return
    const bounds = measure()
    if (state === 'none') {
      // 最初に見えたときに作る。隠れたまま作っても、測れないので待つ。
      if (!shown.value || !bounds || !canCreate()) return
      if (opts.beforeCreate && (await opts.beforeCreate())) return
      // 聞いているあいだに閉じられた・隠れた・動いたら測り直す。
      const at = measure()
      if (disposed || !shown.value || !at || !canCreate()) return
      state = 'creating'
      try {
        await opts.create(label, at)
        opts.onError(null)
      } catch (e) {
        state = 'none'
        opts.onError(String(e))
        // 失敗した古い中身のエラーを出したまま待たせない。
        takePendingRecreate()
        return
      }
      state = 'ready'
      // 作っているあいだに閉じられたら片付ける。
      if (disposed) {
        void browserClose(label)
        return
      }
      // 作ったものは古い。
      if (takePendingRecreate()) return
      // 作っているあいだに隠れた・動いたぶんを反映する（溜まっていなくても 1 回は合わせ直す）。
      syncAgain = true
      return
    }
    if (state !== 'ready') return
    const visible = shown.value && !!bounds
    const key = visible && bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : ''
    if (visible === lastVisible && key === lastBoundsKey) return
    // 送っているあいだに作り直された（`recreate`）ら、この応答は古い子 webview のもの。
    // 成功も失敗も捨てる（閉じた相手への指示なので `no browser webview` が返りうる）。
    const target = label
    try {
      await browserPlace(target, visible, visible ? (bounds ?? undefined) : undefined)
      if (target !== label) return
      // **送れたときだけ覚える。** 失敗したのに覚えると、次に同じ状態を頼まれても
      // 「変わっていない」と見なして送らず、見えたまま（隠れたまま）になる。
      lastVisible = visible
      lastBoundsKey = key
    } catch (e) {
      if (target === label) opts.onError(String(e))
    }
  }

  watch(shown, (v) => (v ? scheduleSync() : void sync()))

  /** 持つ子 webview を差し替え、位置合わせの記録も一緒に戻す。 */
  function resetView(next: string, nextState: 'none' | 'ready', visible: boolean) {
    browserRouter.unregister(label)
    label = next
    browserRouter.register(label, opts.handlers)
    state = nextState
    lastVisible = visible
    lastBoundsKey = ''
    opts.onReset?.()
  }

  /**
   * 子 webview を手放して「まだ作っていない」に戻る。閉じるかどうかは呼ぶ側が決める
   * （作り直すなら閉じ、別のタブへ譲るなら閉じない）。
   */
  function release() {
    resetView(opts.newLabel(), 'none', true)
  }

  /**
   * 別の持ち主から子 webview を受け取る（#402）。最後に送った表示を「隠れている」にしておき、
   * すぐ後の位置合わせで見せる。
   */
  function adopt(next: string) {
    resetView(next, 'ready', false)
    opts.onError(null)
    syncAgain = true
  }

  /** 作っている途中に `recreate` を頼まれた（作り終えたところで作り直す）。 */
  let recreatePending = false

  /**
   * 作り終えた（成否を問わない）ところで、作っているあいだに頼まれた作り直しを果たす。
   * 開く中身が変わったので、成功していれば閉じて作り直し、失敗していれば新しい中身で作る
   * （どちらも `recreate` がそのときの状態に合わせて行う）。果たしたら true。
   */
  function takePendingRecreate(): boolean {
    if (!recreatePending) return false
    recreatePending = false
    recreate()
    return true
  }

  /**
   * 閉じて作り直す（作れなければ閉じるだけ。`canCreate` が見る）。**どの状態から呼んでも効く**:
   * 作っている途中なら作り終えたところで作り直し、まだ無ければ作るだけ。開く中身が変わったと
   * 伝える側（HTML のプレビューの Save As など）は、状態を気にせずこれを呼べばよい。
   *
   * **ラベルも変える**: 閉じる指示は非同期なので、同じラベルで作り直すと、古いものがまだ
   * 残っていて作れないことがある。
   */
  function recreate() {
    if (state === 'creating') {
      recreatePending = true
      return
    }
    if (state === 'ready') {
      void browserClose(label)
      release()
    }
    scheduleSync()
  }

  let observer: ResizeObserver | null = null

  onMounted(() => {
    observer = new ResizeObserver(scheduleSync)
    const el = opts.el.value
    if (el) {
      observer.observe(el)
      // 枠の大きさが固定のとき（ブラウザのタブのスマートフォンの画面）は、入れ物の大きさが
      // 変わっても枠は中央へ動くだけで発火しない。入れ物も見る。
      if (el.parentElement) observer.observe(el.parentElement)
    }
    browserRouter.register(label, opts.handlers)
    scheduleSync()
  })

  onUnmounted(() => {
    disposed = true
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
    browserRouter.unregister(label)
    // 作っている途中なら、作り終えたところで `syncOnce` が片付ける。
    if (state === 'ready') void browserClose(label)
  })

  return {
    shown,
    hiddenNotice,
    /** 今のラベル（作り直すと変わる）。 */
    label: () => label,
    /** 子 webview があり、まだ使えるか。 */
    ready: () => state === 'ready' && !disposed,
    /** 持ち主のコンポーネントがもう外れたか（非同期の問い合わせから戻ったときに見る）。 */
    disposed: () => disposed,
    scheduleSync,
    release,
    adopt,
    recreate,
  }
}
