/**
 * ターミナルの BEL で鳴らす音の間引き（#481）。音そのものは OS のシステム音で、
 * Rust の `system_beep` が鳴らす。
 *
 * **間引きはウィンドウの中のタブをまたいで 1 つ。** xterm は BEL のたびに `onBell` を出し、
 * 自分では間引かない（バイナリを `cat` すると 1 回の出力で数百回来る）。ここで捨てれば
 * IPC も飛ばない。webview はウィンドウごとに別の JS の文脈なので、**別のウィンドウの
 * ベルとは間引き合わない**（同時に鳴っても OS の音が重なるだけなので、それ以上は求めない）。
 *
 * **鳴らす関数は引数で受ける**（tauri を import しない）。`errorLog.ts` と同じく、
 * Node のテストから読めるように保つため。
 */
import { createThrottle } from './errorLog'

/** 2 回の音のあいだに空ける最短の間隔。`\a\a\a` のような連打は 1 回にまとめる。 */
export const BELL_MIN_INTERVAL_MS = 200

const throttle = createThrottle(BELL_MIN_INTERVAL_MS)

/** 間引きを通ったときだけ `beep` を呼ぶ。失敗しても捨てる（鳴らないだけで、知らせる先が無い）。 */
export function ringBell(beep: () => Promise<void>): void {
  if (throttle('bell') === null) return
  beep().catch(() => {})
}
