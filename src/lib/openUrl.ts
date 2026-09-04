import { confirmDialog, confirmWithOption } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useSettingsStore } from '../stores/settings'
import { openUrl } from './tauri'

/**
 * `openUrlWithConfirm` が扱えるリンクか。**プレビューがリンクを振り分けるときの述語**で、
 * これが false なら相対パス（プロジェクト内のファイル）として解決される。
 *
 * **「何を外部として開くか」の正本はこのファイル**。以前は 3 つのプレビューが
 * `href.startsWith('http://') || …` を各自で書いていたので、mailto を足すのに 3 か所を
 * 揃える必要があった。DOMPurify に渡す許可スキーム（`lib/sanitizeHtml.ts`）もここと対で、
 * **開けないスキームはそもそもリンクにしない**（押せるのに何も起きない状態を作らない）。
 */
export function isExternalLink(href: string): boolean {
  return /^(?:https?|mailto):/i.test(href)
}

/**
 * 外部ブラウザで URL を開く（#311）。**外へ出て行く URL は全部このファイルを通る。**
 *
 * **`lib/tauri.ts` ではなくここに置く。** あちらは invoke の型付きラッパーだけを置く層で、
 * 確認ダイアログと i18n とストアを読む流れが混ざっていたのが元の姿だった（移設後、あのファイルの
 * 非型 import は `@tauri-apps/api/core` 1 つだけになる）。`stores/settings.ts` が `lib/tauri.ts`
 * を import しているので承認リストを読もうとすると循環する、というのはその混在が露呈した形で、
 * 理由の本体ではない。**将来あの循環が消えても戻さないこと。**
 *
 * `lib/shortcuts.ts` のように設定側から値を流し込む手は使えない: ここは読み（許可済みか）と
 * 書き（承認を足す）の両方をする。
 *
 * `openUrl`（invoke の薄い包み）は `tauri.ts` に残してある。**Rust 側の http/https の検証も
 * そのまま通る**: どのホストを許すかはフロントの持ち物、実際に開いてよい URL かはバックエンドの
 * 持ち物、という分担は #239 の画像取得と同じ。
 */
export async function openUrlWithConfirm(url: string): Promise<void> {
  // メールは毎回聞く。**承認リストには乗らない**: 鍵にしているのはホスト名で、`mailto:` は
  // それを持たない。「宛先ごとに覚える」形も、宛先の数だけ増えるうえ、承認したいのは
  // 「このドメインのリンクを開くこと」であって「この人にメールを書くこと」ではない。
  if (/^mailto:/i.test(url)) {
    if (await confirmDialog(t('confirm.openMail', { url }))) await openUrl(url)
    return
  }
  const host = httpHost(url)
  if (!host) return
  const settings = useSettingsStore()
  if (!settings.allowedUrlHosts.includes(host)) {
    const { ok, checked } = await confirmWithOption(
      t('confirm.openUrl', { url }),
      t('confirm.openUrlRemember', { host }),
    )
    if (!ok) return
    if (checked) settings.allowUrlHost(host)
  }
  await openUrl(url)
}

/**
 * Docker のポートフォワード（#120）を開く。**確認しない**: 宛先は Pike 自身が張った
 * トンネルの loopback に決まっていて、外部のホストへ出て行かない。
 *
 * **ポート番号だけを受けて URL をここで組み立てるのが要点。** 呼び出し側が素の `openUrl` を
 * 呼ぶ形だと「外へ出て行く URL は全部このファイルを通る」が字義どおりでなくなり、次に
 * 「ブラウザで開く」ボタンを足す人が同じ抜け道を見つける（`check-docs` はシンボルの実在しか
 * 見ないので、この乖離は検出できない）。ここを通れば、承認の仕組みを強化したときに
 * 素通りする経路が残っていないことを、このファイルの中だけで確かめられる。
 *
 * **`openUrlWithConfirm` の中で loopback を無条件に承認済み扱いにする形は採らない。**
 * README に書かれた `http://127.0.0.1:9999/` のような文書由来のリンクまで無確認になる。
 */
export async function openLocalTunnel(port: number): Promise<void> {
  await openUrl(`http://127.0.0.1:${port}/`)
}

/**
 * 承認の鍵にするホスト名。http(s) でなければ、壊れていて読めなければ null。
 *
 * **ポートは見ない**（`hostname` だけ）。完全一致で持つので、`github.com` を許しても
 * `raw.githubusercontent.com` は別扱いになる。サブドメインをまとめる形（`*.github.com`）を
 * 採らないのは、承認したホストと実際に開く先がずれるため。
 *
 * **スキームの判定もここでやる**（`startsWith` で先に弾かない）。URL を 2 つの機構で 2 回読む
 * ことになり、しかも prefix 一致は大小を見るので `HTTP://example.com` で判定が食い違う。
 * `new URL` の `protocol` は正規化済みの値を返す。
 */
function httpHost(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase() || null
  } catch {
    return null
  }
}
