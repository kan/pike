/**
 * ブラウザのタブの子 webview を、別のプロジェクトの同じ URL のタブへ譲る（#402）。
 *
 * プロジェクトを切り替えても前のプロジェクトのタブは生きたまま残る（#264）ので、同じ
 * ページ（Jira のボードなど）を 2 つのプロジェクトで開いていると、切り替えた先のタブが
 * **同じページをもう一度一から読み込む**。読み込み済みの webview が隠れたまま手元にあるのに。
 * そこで、子 webview を作る前にここへ聞き、譲れるものがあればそれを受け取る。譲った側は
 * 「まだ作っていない」状態に戻り、次に見えたときに同じ手順で取り返す（行き来するだけなら
 * 1 つの webview が 2 つのタブのあいだを往復する）。
 *
 * 譲れるかの判定はタブの側が持つ（`BrowserDonor.hold`）。条件は次のとおり:
 * - **別のプロジェクトのタブ**。同じプロジェクトに同じ URL のタブが 2 枚あるのは利用者が
 *   別々に開いたもの（`target=_blank` など）で、見るたびに 1 つのページを取り合うとスクロール
 *   位置や入力が混ざる
 * - **描かれていない**
 * - **作ったときの差し込みのルールが今と同じ**（JS と CSS、Jira の拡張機能は webview を
 *   作った時点で固定される）
 *
 * **同じウィンドウの中だけ。** 子 webview はウィンドウに属し、このモジュールもウィンドウの
 * JS ごとに 1 つなので、登録されているのは自分のウィンドウのタブだけになる。
 *
 * 譲る側が送りかけの「隠す」と、受け取る側の「見せる」の順は `lib/tauri.ts` の `inOrder` が
 * 保つ（ここで待ち合わせない）。
 */
import { browserUrl } from './tauri'

export interface BrowserDonor {
  /** 条件に合えば持っている子 webview のラベル、合わなければ null。 */
  hold: (projectId: string | null | undefined, url: string, rulesKey: string) => string | null
  /** `label` の子 webview を手放してタブの名前を返す。もう持っていなければ null。 */
  release: (label: string) => string | null
}

const donors = new Map<string, BrowserDonor>()

export function registerBrowserDonor(tabId: string, donor: BrowserDonor): void {
  donors.set(tabId, donor)
}

export function unregisterBrowserDonor(tabId: string): void {
  donors.delete(tabId)
}

/**
 * 譲ってもらえる子 webview があれば受け取る（渡した側はもう持っていない）。
 *
 * **ページが今その URL にいるかを `browser_url` で確かめる。** 隠れているあいだは URL の
 * ポーリングが止まるので、ページの中の移動（`pushState`）でタブの `url` は古くなる。
 */
export async function takeBrowserView(
  tabId: string,
  projectId: string | null | undefined,
  url: string,
  rulesKey: string,
): Promise<{ label: string; title: string } | null> {
  for (const [id, d] of donors) {
    if (id === tabId) continue
    const label = d.hold(projectId, url, rulesKey)
    if (!label) continue
    const actual = await browserUrl(label).catch(() => null)
    if (actual !== url) continue
    // 聞いているあいだに状態が変わりうるので、`release` が手放す直前にもう一度確かめる。
    const title = d.release(label)
    if (title !== null) return { label, title }
  }
  return null
}
