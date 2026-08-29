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
 * 矢印キーの表示。chord のキー名は `e.key` に合わせて `ArrowLeft` と書くので（照合が
 * そのまま通るように）、画面に出すときだけ記号へ読み替える。
 */
const ARROW_SYMBOLS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

/**
 * chord の表記を修飾キーとキーに分ける。
 *
 * **区切りと同じ文字がキーになりうる**のが厄介なところで、`'Mod++'` を素朴に
 * `split('+')` すると空の欠片が 2 つ出る。末尾を取ってから空を落とす順にすると、
 * `Mod++` は「`Mod` と `+`」、素の `'+'`（画像プレビューの拡大）は「修飾なしの `+`」に
 * なる。判定・表記・macOS のアクセラレータが同じ答えを見るよう、3 つともここを通す
 * （別々に書いていたころ、一覧が `Mod++` を `Ctrl` とだけ表示していた）。
 */
function splitChord(chord: string): { mods: string[]; key: string } {
  const parts = chord.split('+')
  const key = parts.pop() || '+'
  return { mods: parts.filter(Boolean), key }
}

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
  const { mods, key } = splitChord(chord)
  const parts = [...mods, ARROW_SYMBOLS[key] ?? key]
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

/**
 * `'Mod+Shift+P'` のような表記と、実際の打鍵が一致するか（#254）。
 *
 * これがあるおかげで、chord は**表記・判定・macOS のメニューのアクセラレータの
 * 3 つで同じ文字列**になる。以前は `key === 'p' && e.shiftKey` のような条件と
 * `'Mod+Shift+P'` というリテラルが別々に書かれていた。
 *
 * 規則が 2 つある。
 *
 * - **chord に書いていない修飾キーは押されていないことを求める**（`Mod+P` は
 *   `Mod+Shift+P` に一致しない）
 * - **`Ctrl` は macOS でだけ `Mod` と別物**。Windows / Linux では同じキーなので、
 *   `Ctrl+Tab` は `Mod+Tab` と同じものとして照合する（表記側の `chordChips` が
 *   `Mod` を `Ctrl` と書くのと対）
 */
export function matchChord(e: KeyboardEvent, chord: string): boolean {
  return matchParsedChord(e, parseChord(chord))
}

/**
 * 分解済みの chord。**打鍵のたびに走る照合のため**にある（#261）。
 *
 * ターミナルの取り合いは Ctrl / Alt 付きの打鍵ごとに候補を全部試すので、そのたびに
 * `splitChord` が文字列を割って配列を作ると、素の readline のキー（`Ctrl+C` など、
 * どれにも一致しないもの）が最も高くつく。候補が変わるのはプリセットを切り替えたときだけ
 * なので、分解は computed の側で 1 回だけ行う。
 */
export interface ParsedChord {
  mods: string[]
  key: string
  /** 元の表記。どれに一致したかを呼び出し側が見分けるために持つ。 */
  chord: string
}

export function parseChord(chord: string): ParsedChord {
  const { mods, key } = splitChord(chord)
  return { mods, key, chord }
}

/** 規則は `matchChord` と同じ（あちらがこれを呼ぶ）。 */
export function matchParsedChord(e: KeyboardEvent, { mods, key }: ParsedChord): boolean {
  const has = (name: string) => mods.some((p) => p.toLowerCase() === name)

  if (hasMod(e) !== (has('mod') || (!isMacHost && has('ctrl')))) return false
  // mac でだけ Ctrl は独立した修飾キー。他では上の行が見た `Mod` と同じキーなので、
  // ここで二重に見ると常に成り立つ条件を 1 本増やすだけになる。
  if (isMacHost && e.ctrlKey !== has('ctrl')) return false
  if (e.shiftKey !== has('shift')) return false
  if (e.altKey !== has('alt')) return false

  // **打った文字を先に見る。** 配列を尊重するのが本筋で、`e.code`（物理キー）を
  // 先に見ると配列を替えている人が取り違えを踏む。Dvorak では `,` の物理キーが
  // `KeyW` なので、`e.code` 優先だと `Ctrl+,`（設定）が `Mod+W`（タブを閉じる）に
  // 一致して、設定を開いたつもりでタブが閉じる。
  if (normalizedKey(e) === (key.length === 1 ? key.toLowerCase() : key)) return true

  // `e.key` では届かない場合が 2 つある。macOS の Option は `e.key` を別の文字に
  // 変え（`⌥H` は `˙`）、US 配列の `Shift+]` は `}` になる。どちらも「打った文字」が
  // chord の綴りと一致しようがないので、そのときだけ物理キーに落ちる。
  const code = KEY_CODES[key.toLowerCase()] ?? null
  return code !== null && e.code === code
}

/** `matchChord` が物理キーに落ちるときの対応（英数字と、chord に出る記号）。 */
const KEY_CODES: Record<string, string> = {
  ']': 'BracketRight',
  '[': 'BracketLeft',
  ',': 'Comma',
  ...Object.fromEntries(Array.from('abcdefghijklmnopqrstuvwxyz', (c) => [c, `Key${c.toUpperCase()}`])),
  ...Object.fromEntries(Array.from('0123456789', (d) => [d, `Digit${d}`])),
}

/** 修飾キーを並べる順（Apple の Human Interface Guidelines）。表記と Tauri のアクセラレータで共有する。 */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

/**
 * chord を CodeMirror の keymap の表記にする（`'Mod+H'` → `'Mod-h'`、#261）。
 *
 * **1 文字のキーは小文字にすること。** CodeMirror は修飾キーだけを正規化し、キー名は
 * `e.key` と素で比較する（`normalizeKeyName`）。`Mod-H` と書くと Shift を押したときの
 * `e.key`（`'H'`）としか一致せず、`Ctrl+H` を押しても何も起きない。
 *
 * `toAccelerator` の隣に置くのは、どちらも「chord を別の表記に変える」もので、
 * 分解の規則（`splitChord`）を共有するため。
 */
export function toCodeMirrorKey(chord: string): string {
  const { mods, key } = splitChord(chord)
  return [...mods, key.length === 1 ? key.toLowerCase() : key].join('-')
}

/**
 * `'Mod+Shift+]'` を Tauri（muda）のアクセラレータ表記 `'Shift+Cmd+]'` にする。
 *
 * **`chordChips` の隣に置く。** どちらも「chord 文字列を 1 つの表現に変える」もので、
 * 修飾キーの並び順という同じ知識を使う。別のファイルに置くと、修飾キーを足したときに
 * 直す順序表が 2 つに分かれる（型検査もテストも鳴らない）。
 *
 * 使うのは macOS のメニューだけなので `Mod` は常に `Cmd`。
 */
export function toAccelerator(chord: string): string {
  const { mods, key } = splitChord(chord)
  const ordered = mods
    .slice()
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
    .map((p) => (p.toLowerCase() === 'mod' ? 'Cmd' : p))
  return [...ordered, key].join('+')
}
