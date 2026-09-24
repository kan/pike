import { shallowReactive } from 'vue'
import { findLocalUrls } from '../lib/devServer'

/**
 * ターミナルに出た開発サーバーの `Local:` の URL を、ターミナルのタブごとに覚える（#397）。
 * Vue SFC のプレビュー（`VuePreview.vue`）が、候補の先頭に置く（順の理由は `lib/devServer.ts`）。
 *
 * **出力のたびに呼ばれる**（`TerminalTab` の出力の受け口）ので、`Local` を含まないチャンクは
 * 末尾を持ち越すだけで返す。末尾を持ち越すのは、起動表示の 1 行がチャンクの境目で割れるため。
 * ANSI の除去と照合は `Local` を見つけたときだけ。
 *
 * タブのシェルが終わった・タブを閉じたら忘れる。開発サーバーだけを Ctrl+C で止めたときは
 * 残るが、入口を取りに行った時点で落ちるので害は無い。
 */

interface CapturedDevServer {
  url: string
  /** そのターミナルを開いたディレクトリ。どのプロジェクトのサーバーかの手がかり。 */
  cwd: string
}

/** 起動表示の 1 行が割れても拾える長さ（ANSI 込み）。 */
const TAIL = 512

/** タブ → 拾った URL。**入れ直すときは消してから入れる**ので、後ろほど新しい。 */
const captured = shallowReactive(new Map<string, CapturedDevServer>())
const tails = new Map<string, string>()

function feed(tabId: string, data: string, cwd: string | undefined) {
  if (!cwd) return
  const prev = tails.get(tabId) ?? ''
  // 大きなチャンク（`cat` など）で、捨てるだけの連結を作らない。
  const text = data.length >= TAIL ? data : prev + data
  tails.set(tabId, text.slice(-TAIL))
  if (!text.includes('Local')) return
  const urls = findLocalUrls(text)
  const url = urls[urls.length - 1]
  if (!url || captured.get(tabId)?.url === url) return
  captured.delete(tabId)
  captured.set(tabId, { url, cwd })
}

function forget(tabId: string) {
  tails.delete(tabId)
  captured.delete(tabId)
}

/** 拾った URL を新しい順に。 */
function list(): CapturedDevServer[] {
  return [...captured.values()].reverse()
}

export const devServerUrls = { feed, forget, list }
