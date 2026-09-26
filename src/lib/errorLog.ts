/**
 * フロントのエラーをログファイルへ残す（#415）。書き込み先は Rust の `app_log`。
 *
 * 受け口は 3 つ: `window` の `error`（同期の例外）、`unhandledrejection`（await されなかった
 * Promise の失敗）、Vue の `app.config.errorHandler`（コンポーネントの描画・フック・ウォッチャ）。
 * Vue の中の例外は前 2 つには届かないので、3 つとも要る。
 *
 * **tauri を import しない。** 書き込み先（`sink`）を受け取る形にしてあるのは、間引きと整形を
 * Node のテストから確かめるため（`lib/tauri.ts` は読み込んだ時点でビルド時の定数を見る）。
 *
 * ログにはページの URL やファイルのパスがそのまま入る。外へは送らず手元のファイルに書くだけで、
 * 共有するかは利用者が中身を見て決める（マニュアルに書いてある）。伏せると調べる手がかりが消える。
 */

import type { App } from 'vue'

export type LogLevel = 'error' | 'warn'
export type LogSink = (level: LogLevel, message: string) => void

/** 同じエラーを間引く間隔。描画のたびに出るエラーでファイルが膨らまないように。 */
const REPEAT_WINDOW_MS = 60_000
/** 覚えておくエラーの種類の上限。古いものから忘れる。 */
const MAX_KEYS = 100
/** 1 件の上限。巨大なオブジェクトを JSON にしたものなどで 1 行が膨らまないように。 */
const MAX_MESSAGE = 4_000

/**
 * 同じ `key` が `windowMs` 以内に来たら書かない（`null`）。書くときは、前回から省いた回数を
 * 返す（「その後も出続けていた」ことが分かるように、次に書く 1 件に添える）。
 */
export function createThrottle(windowMs = REPEAT_WINDOW_MS, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; suppressed: number }>()
  return (key: string): number | null => {
    const t = now()
    const prev = seen.get(key)
    if (prev && t - prev.at < windowMs) {
      prev.suppressed++
      return null
    }
    // 入れ直して挿入順の末尾へ回す（`Map` の先頭がいちばん古いものになる）。
    seen.delete(key)
    seen.set(key, { at: t, suppressed: 0 })
    if (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value as string)
    return prev?.suppressed ?? 0
  }
}

/**
 * エラーを 1 件の文字列にする。**スタックの先頭にメッセージが無い環境がある**
 * （WebView2 の V8 は `Name: message` から始めるが、WKWebView の JavaScriptCore は
 * 呼び出し元の一覧だけを返す）ので、無ければ足す。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`
    if (!err.stack) return head
    return err.stack.startsWith(head) ? err.stack : `${head}\n${err.stack}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/**
 * 間引きに使う鍵。スタックを除いた 1 行目で、同じ例外を呼び出し元の違いで別物として数えない。
 * **スタックを組み立てずに作る**: 描画のたびに出るエラーは大半が間引かれるので、捨てる 1 件の
 * ために長い文字列を作らない。
 */
export function errorKey(source: string, err: unknown): string {
  const head = err instanceof Error ? `${err.name}: ${err.message}` : describeError(err)
  return `${source}: ${head.split('\n', 1)[0]}`
}

/** 書く 1 件。長すぎるものは切る。 */
export function formatEntry(source: string, err: unknown): string {
  return `${source}: ${describeError(err)}`.slice(0, MAX_MESSAGE)
}

/**
 * 3 つの受け口を張る。`main.ts` が mount の前に 1 回だけ呼ぶ。
 *
 * Vue は `errorHandler` を置くと自分では console に出さなくなるので、開発中に DevTools で
 * 見えなくならないよう `console.error` を続けて呼ぶ。
 */
export function installErrorLogging(app: App, sink: LogSink): void {
  const throttle = createThrottle()
  const report = (source: string, err: unknown) => {
    const suppressed = throttle(errorKey(source, err))
    if (suppressed === null) return
    const message = formatEntry(source, err)
    sink('error', suppressed > 0 ? `${message}\n(${suppressed} repeats suppressed in the previous window)` : message)
  }

  window.addEventListener('error', (e) => {
    // `error` が無いのはスクリプトの読み込み失敗や、別オリジンで中身が伏せられたもの。
    report('window.onerror', e.error ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`)
  })
  window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason))
  app.config.errorHandler = (err, _instance, info) => {
    console.error(err)
    report(`vue (${info})`, err)
  }
}
