/**
 * ブラウザのタブの閲覧履歴に、いつ載せるかを決める（#412 / #416）。
 *
 * **リダイレクトのページを載せない**のが目的。サーバーのリダイレクト（3xx）は途中のページが
 * 読み込まれないので元から載らないが、ログインの経路などにある JS やメタ refresh の
 * リダイレクトは、途中のページが読み込みを終えてから次へ移る。Chromium はこれをクライアント
 * リダイレクトとして記録し、履歴の画面には連鎖の終点だけを出す（`visit_database.cc` の
 * `TransitionIsVisible` が `PAGE_TRANSITION_CHAIN_END` を見る）。
 *
 * 決め方は 2 通りある。
 *
 * - **移動の知らせで決める**（Windows。`delayMs: null`）… WebView2 の `NavigationStarting` が
 *   ユーザーの操作による移動かを教える（`src-tauri/src/browser_nav.rs`）。読み込んだページは
 *   離れるまで待たせ、**離れる移動がユーザーの操作なら載せ、スクリプトの移動で別のページへ
 *   移ったなら捨てる**。
 *   時間の閾値は無い。代償は、今開いているページが離れるまで一覧に出ないこと（#416 で選んだ）
 * - **時間で近似する**（macOS。`delayMs` に数値）… WKWebView には同じ知らせが無いので、
 *   読み込んでから `delayMs` のあいだに次へ移ったら前のページを捨てる。代償は、その間に
 *   リンクを押して移ったページも載らないこと
 *
 * **ページの中の移動**（`pushState`）は、呼び出し側がパスの変わったものだけを渡す（`isSamePage`）。
 * `replaceState` と `pushState` はどちらの方式でも見分けられないので、線を引くのはパス。
 */

export interface VisitQueueOptions {
  /** 履歴に載せる。 */
  commit: (url: string) => void
  /** `null` なら移動の知らせで決める。数値なら、その時間待って載せる。 */
  delayMs: number | null
  /**
   * タブを作った時点の URL。**同じ URL は 2 度回さない**ので、復元したタブが起動のたびに
   * 履歴の先頭へ上がることは無い（#412 より前もタブの URL と同じなら載せなかった）。
   */
  initialUrl: string
}

export interface VisitQueue {
  /**
   * ページへ移った（読み込みの完了か、パスが変わったページの中の移動）。最後に回した URL と
   * 同じなら何もしない（同じ URL を 2 度回さない判定はここに置く。読み直しの扱いと一緒に決まるため）。
   */
  queue(url: string): void
  /** 次の移動が始まった（移動の知らせで決める方式だけが呼ぶ）。 */
  navigationStarting(userInitiated: boolean): void
  /**
   * 待っているページを載せる。タブやウィンドウを閉じるとき（次へ移っていない以上リダイレクトでは
   * ない）と、**Pike 自身が移動を起こす直前**（アドレス欄・戻る・進む・再読み込み。WebView2 から
   * 見るとユーザーの操作ではないので、知らせを待つとリダイレクトと取り違える）。
   */
  flush(): void
}

export function createVisitQueue(options: VisitQueueOptions): VisitQueue {
  const { commit, delayMs } = options
  /** 最後に回した URL（待っているもの・載せたもの）。 */
  let queuedUrl = options.initialUrl
  /** `queuedUrl` を載せるか決めかねている。 */
  let pending = false
  /**
   * 待っているページを、スクリプトの移動が離れようとしている（知らせで決める方式だけ）。
   *
   * **その場では捨てない。** 捨てるのは、実際に別の URL のページが読み込まれたとき。
   * スクリプトの移動がすべてリダイレクトとは限らない: `location.reload()` や同じ URL への
   * meta refresh は同じページを読み直すだけで、ダウンロードや 204 はページが替わらない。
   * 始まった時点で捨てると、それらのページが履歴から落ちる。
   */
  let leavingByScript = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const settle = (keep: boolean) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const wasPending = pending
    pending = false
    leavingByScript = false
    if (keep && wasPending) commit(queuedUrl)
  }

  return {
    queue(url) {
      if (url === queuedUrl) {
        // 同じページを読み直した（上の `leavingByScript` の reload）。離れていないので待たせたまま。
        leavingByScript = false
        return
      }
      // 知らせで決める方式: スクリプトの移動で別のページへ移ったなら、前のページはリダイレクト。
      // それ以外で残っているのは、ページの中の移動で離れたとき（`NavigationStarting` が来ない）
      // なので載せる。近似の方式: 待っているあいだに次へ移った＝リダイレクトとみなして捨てる。
      settle(delayMs === null && !leavingByScript)
      queuedUrl = url
      pending = true
      if (delayMs !== null) timer = setTimeout(() => settle(true), delayMs)
    },
    navigationStarting(userInitiated) {
      if (userInitiated) settle(true)
      else if (pending) leavingByScript = true
    },
    flush() {
      settle(true)
    },
  }
}
