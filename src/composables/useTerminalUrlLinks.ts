/**
 * ターミナルの出力の URL をリンクにする（#343 で設定から切れるようにした）。xterm を載せる
 * 2 つのタブ（ターミナルと Docker ログ）が共有する。
 *
 * **`WebLinksAddon` は後から黙らせられない**（作るときにハンドラを渡すだけで、有効・無効の
 * 口が無い）。設定を切ったときに下線とカーソルまで消すには、アドオンごと外して付け直す
 * しかないので、その出し入れをここに閉じる。
 *
 * **ハンドラ側で「設定が OFF なら何もしない」にはしないこと。** それでは押せる見た目のまま
 * 何も起きないリンクが残り、「リンク化を完全にオフ」という設定の言葉が嘘になる。
 */
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Terminal } from '@xterm/xterm'
import { watch } from 'vue'
import { openUrlWithConfirm } from '../lib/openUrl'
import { useSettingsStore } from '../stores/settings'

/**
 * 設定に追従して URL のリンク化を付け外しする。
 *
 * **`onMounted` の中で、await より前に呼ぶこと。** そうすれば watcher がコンポーネントの
 * effect scope に入り、アンマウントで止まる（アドオン自体も `terminal.dispose()` が
 * `AddonManager` 経由で落とす）。後始末の関数を返さないのはそのため。**await のあとへ
 * 動かすと scope から外れ、タブを閉じても watcher が残る。**
 *
 * **付け直すとリンクの優先順位が変わる。** xterm は**登録順が優先順位**なので、OFF → ON で
 * 作り直したアドオンはパスのプロバイダより後ろに入る。だから**パス側が URL を拾わない**
 * ことに依存関係がある（`lib/terminalLinks.ts` の `asPathHeader` の `://` のガード）。
 */
export function attachUrlLinks(term: Terminal) {
  const settings = useSettingsStore()
  let addon: WebLinksAddon | null = null

  watch(
    () => settings.terminalUrlLinks,
    (on) => {
      if (on && !addon) {
        addon = new WebLinksAddon((_e, uri) => openUrlWithConfirm(uri))
        term.loadAddon(addon)
      } else if (!on && addon) {
        addon.dispose()
        addon = null
      }
    },
    { immediate: true },
  )
}
