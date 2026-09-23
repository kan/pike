/**
 * ブラウザのタブに出すサイトのアイコン（#400）。取ってくるのは Rust の `browser_favicon`。
 *
 * **オリジンごとに覚える**（同じサイトのページを渡り歩くたびに取り直さない）。失敗も
 * `null` として覚える: アイコンを持たないサイトを、ページを移るたびに叩かないため。
 *
 * **取りに行くのはページを読み込んだときだけ**（`BrowserTab.vue` が呼ぶ）。セッションの
 * 復元ではページを読み込まない（`types/tab.ts` の `BrowserTab`）ので、アイコンのためだけに
 * 外へ出て行かない。それまでは種別の地球儀が出る。
 *
 * 画像はセッションに書かない（`project.json` に data URL を積まない）。ウィンドウの JS の
 * 寿命のあいだだけ持つ。
 */
import { shallowReactive } from 'vue'
import { browserFavicon } from './tauri'

const icons = shallowReactive(new Map<string, string | null>())
const inflight = new Set<string>()

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** 覚えているアイコンの data URL。まだ無い・取れなかったときは null。 */
export function browserIcon(url: string): string | null {
  const origin = originOf(url)
  return (origin && icons.get(origin)) || null
}

/** そのページのオリジンのアイコンを、まだ知らなければ取りに行く。 */
export function requestBrowserIcon(url: string): void {
  const origin = originOf(url)
  if (!origin || icons.has(origin) || inflight.has(origin)) return
  inflight.add(origin)
  void browserFavicon(url)
    .then((img) => icons.set(origin, img ? `data:${img.mime};base64,${img.base64}` : null))
    .catch(() => icons.set(origin, null))
    .finally(() => inflight.delete(origin))
}
