/**
 * プリセット（#261）で変わる CodeMirror 側のキー。
 *
 * `lib/shortcuts.ts` の `terminalClaims`（xterm 側の取り合い）と対になるもので、**どちらも
 * 「プリセットが取った chord を、別の層に食われないようにする」**という同じ問題を扱う。
 * こちらを検索パネルのファイル（`editorSearch.ts`）に置いていたころは、検索の実装を触る人が
 * IDEA 互換のタブ移動の話まで読む羽目になっていた。
 *
 * **`EditorTab.vue` は compartment に入れて、設定を変えたら張り直すこと**（開いているタブに
 * 反映されない）。**`defaultKeymap` より前に登録すること**（後述の shadow が効かない）。
 */
import type { Extension } from '@codemirror/state'
import { type KeyBinding, keymap } from '@codemirror/view'
import { openReplace } from './editorSearch'
import { toCodeMirrorKey } from './keys'
import { editorChords, keyBindings } from './shortcuts'

/**
 * グローバル側が取る chord のうち、**CodeMirror の既定と重なるので塞ぐもの**。
 *
 * IDEA 互換のタブ移動 `Alt+←→` は `defaultKeymap` の `cursorSyntaxLeft/Right` と同じキーで、
 * CodeMirror は `stopPropagation: true` を宣言した binding でしか伝播を止めない。よって
 * そのままだと**カーソルが 1 つ動いたうえでタブも切り替わる**。`true` を返す空のコマンドを
 * 先に置くと、CodeMirror はそこで止まり（カーソルは動かない）、伝播は続くので window の
 * ハンドラが受けてタブだけが切り替わる。
 *
 * 一覧を固定にしてあるのは、CodeMirror の既定と本当に重なるものだけを対象にしたいため。
 * プリセットがその chord を取っていなければ何も足さない。
 */
const SHADOWABLE_CHORDS = ['Alt+ArrowLeft', 'Alt+ArrowRight']

export function presetKeymap(): Extension {
  const replace: KeyBinding = {
    key: toCodeMirrorKey(editorChords.value.replace),
    preventDefault: true,
    run: (view) => {
      openReplace(view)
      return true
    },
  }
  const claimed = new Set(keyBindings.value.filter((b) => b.action).flatMap((b) => b.chords))
  const shadowed: KeyBinding[] = SHADOWABLE_CHORDS.filter((c) => claimed.has(c)).map((c) => ({
    key: toCodeMirrorKey(c),
    run: () => true,
  }))
  return keymap.of([replace, ...shadowed])
}
