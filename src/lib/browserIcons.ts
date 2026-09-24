/**
 * ブラウザのタブに出すサイトのアイコン（#400）。取ってくるのは Rust の `browser_favicon`。
 *
 * **オリジンごとに覚える**（同じサイトのページを渡り歩くたびに取り直さない）。
 *
 * **取りに行くのはページを読み込んだときだけ**（`BrowserTab.vue` が呼ぶ）。セッションの
 * 復元ではページを読み込まない（`types/tab.ts` の `BrowserTab`）ので、アイコンのためだけに
 * 外へ出て行かない。
 *
 * **取れたアイコンは localStorage（`pike:browser-icons`）に残す。** 残さないと、再起動して
 * 復元したタブはページを読み込むまで種別の地球儀のままで、固定タブの「アイコンだけの幅」
 * （`TabItem.vue` の `iconOnly`。アイコンがあるときだけ効く）も起動直後は効かない。
 * - **32px 四方の PNG に縮めてから残す**（表示は 16px なので高 DPI でも足りる）。大きな
 *   favicon や SVG をそのまま積むと、設定と共有している localStorage の枠を食う。件数も
 *   `MAX_STORED` で切り、古いものから捨てる
 * - **残したものはすぐ使い、そのセッションで初めてそのサイトを読み込んだときに 1 回だけ
 *   取り直す**（アイコンが変わったサイトに古いものを出し続けない）
 * - 取れなかったこと（null）は残さない。次の起動でもう一度試す
 * - この機械だけのもので、同期も他のウィンドウへの通知もしない（他のウィンドウは次に
 *   開いたときに読む）。`project.json` にも書かない（data URL を積まない）
 */
import { shallowReactive } from 'vue'
import { loadJson, saveJson } from './storage'
import { browserFavicon } from './tauri'

const STORE_KEY = 'pike:browser-icons'

/** 残すオリジンの数。1 件は数 KB なので、これで localStorage の数百 KB に収まる。 */
const MAX_STORED = 200

/** 縮めたあとの 1 辺（px）。 */
const ICON_PX = 32

/** 縮めても大きいもの（縮められなかったもの）は残さない。 */
const MAX_STORED_LEN = 16 * 1024

/** 残したアイコンを読む。形が崩れたものは捨てる（手で編集された、版の違う Pike が書いた）。 */
function loadStored(): [string, string][] {
  const list = loadJson<unknown>(STORE_KEY, [])
  if (!Array.isArray(list)) return []
  return list.filter(
    (e): e is [string, string] =>
      Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && e[1].startsWith('data:image/'),
  )
}

/**
 * 残す。**書く直前に読み直す**（localStorage はウィンドウ間で共有なので、起動時に読んだ
 * 配列を書き戻すと、そのあいだに別のウィンドウが足したものを消す）。新しいものが先頭。
 */
function persist(origin: string, icon: string) {
  if (icon.length > MAX_STORED_LEN) return
  const next = [[origin, icon], ...loadStored().filter(([o]) => o !== origin)].slice(0, MAX_STORED)
  saveJson(STORE_KEY, next)
}

const icons = shallowReactive(new Map<string, string | null>(loadStored()))
/** このセッションで取りに行ったオリジン（取り直しは 1 回だけ）。 */
const fetched = new Set<string>()

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/**
 * `ICON_PX` 四方の PNG に縮める（縦横比は保つ）。描けなければ元のまま返す（そのセッションの
 * 表示には使えるが、`persist` が大きさで弾く）。
 */
async function shrink(dataUrl: string): Promise<string> {
  try {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = ICON_PX
    canvas.height = ICON_PX
    const ctx = canvas.getContext('2d')
    if (!ctx || !img.naturalWidth || !img.naturalHeight) return dataUrl
    const scale = Math.min(ICON_PX / img.naturalWidth, ICON_PX / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (ICON_PX - w) / 2, (ICON_PX - h) / 2, w, h)
    return canvas.toDataURL('image/png')
  } catch {
    return dataUrl
  }
}

/** 覚えているアイコンの data URL。まだ無い・取れなかったときは null。 */
export function browserIcon(url: string): string | null {
  const origin = originOf(url)
  return (origin && icons.get(origin)) || null
}

/**
 * そのページのオリジンのアイコンを、このセッションでまだ取りに行っていなければ取りに行く。
 * 残してあったものがあれば、取り直すあいだもそれを出したままにする。
 */
export function requestBrowserIcon(url: string): void {
  const origin = originOf(url)
  if (!origin || fetched.has(origin)) return
  fetched.add(origin)
  void browserFavicon(url)
    .then(async (img) => {
      if (!img) {
        // 取れなかった。残してあったものがあればそれを出し続ける。
        if (!icons.get(origin)) icons.set(origin, null)
        return
      }
      const icon = await shrink(`data:${img.mime};base64,${img.base64}`)
      icons.set(origin, icon)
      persist(origin, icon)
    })
    .catch(() => {
      if (!icons.get(origin)) icons.set(origin, null)
    })
}
