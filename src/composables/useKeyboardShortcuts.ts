import { onMounted, onUnmounted } from 'vue'
import { isMacHost } from '../lib/host'
import { hasMod, normalizedKey } from '../lib/keys'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
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
  const tabStore = useTabStore()
  const projectStore = useProjectStore()
  const actions = useAppActions()

  function onKeyDown(e: KeyboardEvent) {
    const key = normalizedKey(e)
    const mod = hasMod(e)
    // Block the WebView reload accelerators (Ctrl/Cmd+R, Shift too, F5). A stray
    // reload tears down every PTY/terminal session, which looks like an app
    // restart (issue #96). Vite HMR still reloads on file change during dev.
    if ((mod && key === 'r') || key === 'F5') {
      e.preventDefault()
      return
    }

    // F1: open the user manual
    if (key === 'F1') {
      e.preventDefault()
      actions.manual()
      return
    }

    // `e.ctrlKey` も見る。macOS の `mod` は Cmd なので、これを落とすと下の
    // Ctrl+Tab / Ctrl+PageUp / Ctrl+PageDown（mac でも Ctrl のまま）がここで死ぬ。
    if (!mod && !e.ctrlKey && !e.altKey) return

    // **ここから 2 つはオーバーレイの早期 return より前**（下の `showSwitcher` の行）。
    // 通すアクションの一覧は `useAppActions` の `OVERLAY_ALLOWED_ACTIONS` が正本で、
    // メニュー側はそちらを引く。増やすときは両方を直すこと。
    // Mod+Shift+P: project switcher
    if (mod && e.shiftKey && key === 'p') {
      e.preventDefault()
      actions.projectSwitcher()
      return
    }

    // Mod+P: quick open file
    if (mod && !e.shiftKey && key === 'p') {
      e.preventDefault()
      actions.quickOpen()
      return
    }

    // Don't handle shortcuts when the switcher or quick open is open
    if (projectStore.showSwitcher || projectStore.showQuickOpen) return

    // Mod+S: prevent browser save dialog (EditorTab handles save via CodeMirror)
    if (mod && key === 's') {
      e.preventDefault()
      return
    }

    // Mod+F / Mod+H: prevent browser find dialog. The active view handles the
    // shortcut itself (CodeMirror in the editor, a window listener in DiffTab).
    if (mod && (key === 'f' || key === 'h')) {
      e.preventDefault()
      return
    }

    // Mod+W: close active tab（タブが無ければウィンドウ。判断は action 側に 1 本）
    // Mod+Shift+W: close the window. macOS ではどちらもメニュー側が先に取るが、
    // メニューバーを持たない Windows / Linux にキーが無いと、action 表の
    // `closeWindow` が macOS 専用になってしまう。
    if (mod && key === 'w') {
      e.preventDefault()
      if (e.shiftKey) actions.closeWindow()
      else actions.closeTab()
      return
    }

    // Mod+N: new blank editor tab
    if (mod && key === 'n') {
      e.preventDefault()
      actions.newFile()
      return
    }

    // Mod+T: new terminal tab
    if (mod && key === 't') {
      e.preventDefault()
      actions.newTerminal()
      return
    }

    // Mod+1〜9: n 番目のタブへ。メニューには載せない（Window メニューを 9 項目
    // 太らせるだけになる）。数字の解釈は action 側。
    if (mod && !e.shiftKey && key >= '1' && key <= '9') {
      e.preventDefault()
      actions.selectTabByDigit(key)
      return
    }

    // Mod+Shift+] / Mod+Shift+[: cycle tabs. macOS ではネイティブメニューが握るので
    // ここへは来ないが、Windows でも同じキーで動くように両方に置いてある。
    // **`e.code` で見ること**: US 配列の `Shift+]` は `e.key` が `}` になる。
    if (mod && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault()
      if (e.code === 'BracketRight') actions.nextTab()
      else actions.prevTab()
      return
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs. Ctrl even on macOS — this is the
    // browser/terminal convention there too, and Cmd+Tab belongs to the OS.
    if (e.ctrlKey && key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) actions.prevTab()
      else actions.nextTab()
      return
    }

    // Ctrl+PageDown / Ctrl+PageUp: cycle tabs (VS Code compatible)
    if (e.ctrlKey && (key === 'PageDown' || key === 'PageUp')) {
      e.preventDefault()
      if (key === 'PageDown') actions.nextTab()
      else actions.prevTab()
      return
    }

    // Mod+K: keyboard shortcuts modal.
    // Not while a Markdown editor has focus: `markdownAssistKeymap` (#241) binds
    // it to link insertion with `stopPropagation`, so the key never reaches here.
    // That is also why Mod+K is *not* a macOS menu accelerator (#254) — a menu
    // item would take the key before CodeMirror ever sees it.
    if (mod && key === 'k') {
      e.preventDefault()
      actions.shortcuts()
      return
    }

    // Mod+,: open settings tab
    if (mod && key === ',') {
      e.preventDefault()
      actions.settings()
      return
    }

    // Alt+H: open Git History (editor tabs only).
    // `e.code` と `e.key` の両方を見る。macOS の Option+H は `e.key` が `˙`
    // （合成用の記号）になるので `e.key` だけでは mac で一度も一致せず、`e.code` だけに
    // すると物理配列を見ることになって Dvorak 等で H の位置が変わる（#254）。
    if (e.altKey && (e.code === 'KeyH' || key === 'h')) {
      const active = tabStore.activeTab
      if (active?.kind === 'editor') {
        e.preventDefault()
        tabStore.addHistoryTab({ filePath: active.path })
      }
      return
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
