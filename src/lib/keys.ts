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
