import { onMounted, onUnmounted } from 'vue'
import { isMacHost } from '../lib/host'
import { hasMod, matchChord, normalizedKey } from '../lib/keys'
import { KEY_BINDINGS, MODIFIERLESS_KEYS } from '../lib/shortcuts'
import { useProjectStore } from '../stores/project'
import { useAppActions } from './useAppActions'

/**
 * ターミナルにフォーカスがあっても Pike が処理する Ctrl+キー（#224）。
 *
 * 既定はシェル優先である。xterm は PTY へ送るキーで `preventDefault` だけでなく
 * **`stopPropagation` も呼ぶ**（`cancel(ev, true)`）ので、下のハンドラには Ctrl+英字も
 * Tab も PageUp/Down も F1 も届かない。`TerminalTab.vue` の
 * `attachCustomKeyEventHandler` がこの一覧のキーだけ `false` を返して xterm に
 * 処理させず、window まで通している。
 *
 * **これは Windows / Linux の話。** macOS のショートカットは Cmd で、xterm は
 * `metaKey` を素通しする（＝Ctrl は丸ごとシェルのもの）ため、この取り合い自体が
 * 起きない（#254）。
 *
 * 中身はタブの出し入れ（閉じる・新規・切替）に絞ってある。readline が使う
 * `Ctrl+K`（行末まで削除）・`Ctrl+P` / `Ctrl+N`（履歴）はシェルのまま。
 * 一覧を変えたら `KeyboardShortcuts.vue` と `docs/manual/shortcuts-and-cli.md` も揃える。
 */
export const PIKE_FIRST_CTRL_KEYS = new Set(['w', 't', 'Tab', 'PageUp', 'PageDown', ...'123456789'])

/**
 * 上のうち、全画面 TUI が代替画面を持っているあいだはシェルへ返すもの（#224）。
 * `Ctrl+W` は vim のウィンドウ操作の prefix なので、vim を開いているあいだ Pike が
 * 奪うと `Ctrl+W s` などが一切打てず、しかもタブが閉じる。素のシェル（readline の
 * unix-werase）では Pike 優先のままにするので、判定は代替画面の有無で行う。
 * `Ctrl+T` やタブ切替は全画面 TUI での用途が薄いのでここには入れない。
 *
 * mac では上の分岐が先に返すのでこの集合は使われない（あちらは Ctrl を丸ごとシェルへ渡す）。
 *
 * 数字（`Ctrl+1`〜`Ctrl+9`＝N 番目のタブへ）は入れる。xterm が割り当てる制御文字の
 * うち `Ctrl+6`（`0x1e`＝vim の `Ctrl+^`＝別ファイルへ切替）と `Ctrl+3`（ESC）は
 * 全画面 TUI で日常的に使うため。素のシェルでは使い道がほぼ無いので Pike 優先のまま。
 */
export const ALT_SCREEN_SHELL_KEYS = new Set(['w', ...'123456789'])

/**
 * macOS で Pike が取る Ctrl+キー（#254）。
 *
 * mac の Ctrl+英字と Ctrl+数字は readline のもの（`Ctrl+W` は unix-werase、`Ctrl+T` は
 * transpose）で、Pike のショートカットは Cmd 側にある。**残すのはこの 3 つだけ**: mac でも
 * タブ切替に使うキーで、xterm はこれらを PTY へ送って `stopPropagation` するため、
 * 返すとターミナルにフォーカスがあるあいだタブを切り替える手段が 1 つも無くなる。
 *
 * `PIKE_FIRST_CTRL_KEYS` からの派生にしないこと。文字数で引き算すると、あちらに
 * キーを足した人が**名前が 1 文字かどうかで mac の挙動が決まる**ことに気付けない。
 */
export const MAC_PIKE_FIRST_KEYS = new Set(['Tab', 'PageUp', 'PageDown'])

/**
 * そのキーを Pike が取るか（`false` ならシェルへ渡す）。ターミナルはこれを聞くだけにして、
 * 判定そのものは上の集合と同じ場所に置く。
 */
export function pikeTakesCtrlKey(key: string, inAltScreen: boolean): boolean {
  if (isMacHost) return MAC_PIKE_FIRST_KEYS.has(key)
  if (!PIKE_FIRST_CTRL_KEYS.has(key)) return false
  // 全画面 TUI が代替画面を持っているあいだは、その TUI のものとして譲る。
  return !(inAltScreen && ALT_SCREEN_SHELL_KEYS.has(key))
}

/**
 * グローバルショートカット（window の keydown）。
 *
 * 修飾キーの読み替えは `lib/keys.ts` の `hasMod` が持つ（mac は Cmd、他は Ctrl）。
 * **macOS では、ここの `hasMod` 分岐のうちネイティブメニューにも載っているものは
 * 実行時に一度も通らない**（メニューの key equivalent を AppKit が WebView より先に
 * 処理するため。`src-tauri/src/appmenu/mod.rs`）。それでも同じ表を残すのは、
 * メニューを持たない Linux が同じキーで動く必要があるから。動作の実体は
 * `useAppActions` に 1 本だけあるので、2 つの入口が食い違うことはない。
 */
export function useKeyboardShortcuts() {
  const projectStore = useProjectStore()
  const actions = useAppActions()

  function onKeyDown(e: KeyboardEvent) {
    // WebView のリロードは常に潰す。踏むと全 PTY が落ちて再起動に見える（#96）。
    // **修飾キーを問わない**ので表には載せない（`Ctrl+F5` も `Shift+F5` もリロード）。
    if ((hasMod(e) && normalizedKey(e) === 'r') || e.key === 'F5') {
      e.preventDefault()
      return
    }

    // 修飾キーを 1 つも押していない打鍵は、`F1` を除いて表のどれとも一致しない。
    // 本文の入力や矢印キーで下の走査を走らせないための門番。`e.ctrlKey` も見るのは、
    // macOS の `Mod` が Cmd で、`Ctrl+Tab` 系がここで死ぬため。
    if (!hasMod(e) && !e.ctrlKey && !e.altKey && !MODIFIERLESS_KEYS.has(e.key)) return

    const overlayOpen = projectStore.showSwitcher || projectStore.showQuickOpen

    for (const b of KEY_BINDINGS) {
      if (overlayOpen && !b.always) continue
      if (b.macOnly && !isMacHost) continue
      if (!b.chords.some((c) => matchChord(e, c))) continue
      e.preventDefault()
      // action 無しは「ブラウザの既定を潰すだけ」（実処理は CodeMirror などの別の層）。
      if (b.action) actions[b.action]()
      return
    }
    if (overlayOpen) return

    // `Mod+1`〜`Mod+9`: n 番目のタブへ。**表には載せない**（`AppActionId` を 9 個
    // 太らせる割に、引数付きのアクションは表の型に載らない）。ただし**判定は
    // `matchChord` を通す**: 手書きに戻すと、mac の Ctrl の扱いや配列フォールバックと
    // いった chord の規則が数字キーにだけ届かなくなる。数字の解釈は action 側（`9` は
    // 最後のタブ）。メニューにも載せない（Window メニューを 9 項目太らせるだけ）。
    const digit = [...'123456789'].find((d) => matchChord(e, `Mod+${d}`))
    if (digit) {
      e.preventDefault()
      actions.selectTabByDigit(digit)
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
