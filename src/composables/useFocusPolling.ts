import { watch } from 'vue'
import { windowFocused } from '../lib/window'

/** 1 本のタイマー。`every` ミリ秒ごとに `tick` を呼ぶ。 */
export interface PollInterval {
  every: number
  tick: () => void
}

/**
 * 「ウィンドウがアクティブなあいだだけポーリングし、戻ってきたら 1 回取り直す」を
 * 1 箇所に集約したもの（#277）。git / docker / worktree / usage の 4 ストアが同じ形を
 * 各自で書いており、`document.hasFocus()` ＋ focus/blur リスナ ＋ `AbortController` ＋
 * `setInterval` の張り直しを 4 組持っていた。
 *
 * **フォーカスの出典は `lib/window.ts` の `windowFocused`**（＝ Rust の
 * `WindowEvent::Focused`）。`document.hasFocus()` はタイトルバーだけをクリックして
 * ウィンドウがアクティブになったときや、トレイから復帰したときに webview へフォーカスが
 * 入らないので、そのあいだポーリングが止まったままになる。
 *
 * **タイマーもこちらが持つ**。フォーカス側だけ畳むと「張る前に必ず消す」という不変条件が
 * 呼び出し側に 4 つ残り、5 つ目を書く人が落とせる。
 *
 * 復帰時に撃つのは**先頭の interval だけ**。どのストアもそれが主ポーリングで、後ろに
 * 続くのは自前の間隔ガードを持つ重い処理（git の `fetchInBackground`）なので、
 * フォーカスのたびに促したくない。
 *
 * **ストアの setup 直下で呼ぶこと。** 監視はここで 1 回だけ張り、`start` / `stop` は
 * その有効・無効を切り替えるだけなので、watcher の持ち主は Pinia がストアごとに張る
 * effect scope になる。`start()` の中で張ると、`onMounted` から呼ばれたときに
 * コンポーネントの scope に入ってマウント解除で黙って止まる。
 */
export function useFocusPolling(intervals: PollInterval[]) {
  let timers: ReturnType<typeof setInterval>[] = []
  let active = false

  function clearTimers() {
    for (const timer of timers) clearInterval(timer)
    timers = []
  }

  function startTimers() {
    clearTimers()
    timers = intervals.map(({ every, tick }) => setInterval(tick, every))
  }

  watch(windowFocused, (focused) => {
    if (!active) return
    if (!focused) {
      clearTimers()
      return
    }
    // タイマーの 1 周期ぶん古い表示のままにしないための取り直し。
    intervals[0]?.tick()
    startTimers()
  })

  return {
    /** ポーリングを開始する。既に動いていれば張り直す。 */
    start() {
      active = true
      clearTimers()
      if (windowFocused.value) startTimers()
    },
    /** タイマーを止める。`windowFocused` が変わっても再開しない。 */
    stop() {
      active = false
      clearTimers()
    },
  }
}
