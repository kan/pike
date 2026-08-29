import { onMounted, onUnmounted } from 'vue'
import { isMacHost } from '../lib/host'
import { hasMod, matchChord, normalizedKey } from '../lib/keys'
import { keyBindings, MODIFIERLESS_KEYS } from '../lib/shortcuts'
import { useProjectStore } from '../stores/project'
import { useAppActions } from './useAppActions'

/**
 * ターミナルにフォーカスがあるとき Pike が先に取るキーの一覧と、その判定は
 * **`lib/shortcuts.ts` に置いてある**（#224 / #261）。割り当ての表と同じ場所に無いと、
 * プリセットでキーが変わったときに取り合いの一覧だけが古いまま残る。
 *
 * 既定はシェル優先である。xterm は PTY へ送るキーで `preventDefault` だけでなく
 * **`stopPropagation` も呼ぶ**（`cancel(ev, true)`）ので、下のハンドラには Ctrl+英字も
 * Tab も PageUp/Down も F1 も届かない。`TerminalTab.vue` の
 * `attachCustomKeyEventHandler` が `pikeTakesTerminalKey` の言うキーだけ `false` を
 * 返して xterm に処理させず、window まで通している。
 */

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
    if (!hasMod(e) && !e.ctrlKey && !e.altKey && !MODIFIERLESS_KEYS.value.has(e.key)) return

    const overlayOpen = projectStore.showSwitcher || projectStore.showQuickOpen

    for (const b of keyBindings.value) {
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
