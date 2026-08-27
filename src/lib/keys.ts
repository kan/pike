/**
 * キーボードショートカットの判定を 1 箇所に集める（#254）。
 *
 * Pike はキーを 4 つの層で扱う（グローバル・CodeMirror・xterm・各モーダル）。
 * どの層も `e.ctrlKey` を直書きしていたため、macOS では Cmd を押しても何も起きず、
 * Ctrl はシェルのものと取り合いになっていた。修飾キーの読み替えはここだけが知る。
 *
 * **CodeMirror の `Mod-` はそのまま使う。** あちらは自前で mac を見ており、この
 * モジュールを通す必要がない（作法が 2 つあるように見えるが、`Mod-` が
 * CodeMirror 版の `hasMod` そのもの）。
 */

import { isMacHost } from './host'

/**
 * Pike のショートカットの修飾キーが押されているか。macOS は Cmd、それ以外は Ctrl。
 *
 * mac で Ctrl を使わないのは、あれがターミナル（readline・vim）と全画面 TUI の
 * ものだから。`.claude/rules/terminal.md` の #224 の一連の回避策は、Windows で
 * Ctrl を Pike とシェルで分け合っているせいで必要になっている。
 *
 * `MouseEvent` も受けるのは Ctrl+Click（定義ジャンプ）のため。mac ではあちらも
 * Cmd でなければならない（Ctrl+Click は右クリックそのもの）。
 */
export function hasMod(e: KeyboardEvent | MouseEvent): boolean {
  return isMacHost ? e.metaKey : e.ctrlKey
}

/**
 * `e.key` を比較用に正規化する。Caps Lock は英字の大小を反転させるので、`'p'` の
 * ような小文字リテラルと直接比べると Caps 中にショートカットが全滅する。印字される
 * キーを見るハンドラは全部これを通す。
 */
export function normalizedKey(e: KeyboardEvent): string {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

/**
 * ドラッグ&ドロップを「移動」ではなく「コピー」にする修飾キー。
 *
 * **`hasMod` とは別物。** あちらは「Pike のショートカットの修飾キー」で、こちらは
 * OS のファイル操作の作法（Windows / Linux は Ctrl、macOS は Option）。macOS の
 * Ctrl+ドラッグは副ボタンのクリックそのものなので、`hasMod` を使うと mac で
 * コピーに使える修飾キーが 1 つも無くなる。
 */
export function isCopyDragModifier(e: DragEvent | MouseEvent): boolean {
  return isMacHost ? e.altKey : e.ctrlKey
}

/**
 * 表記の中で修飾キーを表す語。`Mod` は「Pike のショートカットの修飾キー」で、
 * `hasMod` と対になる。`Ctrl` / `Alt` / `Shift` は**読み替えずにそのまま**の意味
 * （mac でも Ctrl のままのキーがあるため。`Ctrl+Tab` 等）。
 */
const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Cmd: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
}

/** mac のキャップに並べる順（Apple の Human Interface Guidelines）。 */
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘']

/**
 * `'Mod+Shift+P'` のような表記を、画面に出す `<kbd>` の並びにする（#254）。
 *
 * Windows / Linux は `['Ctrl', 'Shift', 'P']` と 1 語ずつ。macOS は記号を
 * `⌃⌥⇧⌘` の順に畳んで `['⇧⌘P']` の 1 つにする（mac のメニューの見た目に合わせる。
 * 記号を別々のキャップに割ると、`⌘` だけが浮いて読みづらい）。
 *
 * 修飾キーを含まない表記（`'F1'`、`'テキスト選択'`）はそのまま 1 つで返す。
 */
export function chordChips(chord: string): string[] {
  const parts = chord.split('+').filter(Boolean)
  // 表記そのものが `+`（画像プレビューの拡大）のときは分割結果が空になる。
  if (parts.length === 0) return [chord]
  if (!isMacHost) return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p))

  const symbols = parts.filter((p) => p in MAC_SYMBOLS).map((p) => MAC_SYMBOLS[p])
  const rest = parts.filter((p) => !(p in MAC_SYMBOLS))
  if (symbols.length === 0) return rest
  symbols.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b))
  return [symbols.join('') + rest.join('+')]
}

/** `chordChips` を 1 つの文字列にしたもの（ツールチップ・本文に混ぜる用）。 */
export function chordLabel(chord: string): string {
  return chordChips(chord).join(isMacHost ? '' : '+')
}
