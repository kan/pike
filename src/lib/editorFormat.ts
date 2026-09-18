/**
 * エディタのクイック整形（#366）。選択範囲、無ければファイル全体を整形する。
 *
 * - 言語の整形 … JSON（自前の字下げ。`reindentJson` の doc）と、HTML / XML / CSS /
 *   JavaScript（`js-beautify`）。**`js-beautify` は使うときだけ読み込む**（動的 import）。
 *   起動のたびに整形器を読むのは「軽さ最優先」に反する
 * - 行の整形 … 1 行にする・指定した文字で改行・行末の空白を消す・並べ替え。依存なし
 *
 * **整形できなかったら何も書き換えない**（壊れた JSON を途中まで直す、はしない）。理由は
 * StatusBar に出す。
 *
 * 範囲は選択の main だけ（複数カーソルは main 以外を見ない）。行の整形は、選択が行の途中で
 * 始まっていても行全体に広げる（行の途中から並べ替えても意味が無い）。
 *
 * **入口は 3 つあり、どれも `runFormat` を通す**（右クリック・キー・パレット）。段取り
 * （種別の解決・区切り文字を聞く・整形・適用・通知）をここに置くのは、入口を足すたびに
 * コンポーネントへ配線が増えないようにするため。
 */

import type { EditorView } from '@codemirror/view'
import { promptDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import { useSettingsStore } from '../stores/settings'
import { useStatusMessageStore } from '../stores/statusMessage'
import { FILE_TYPE_LABELS } from './fileType'

/** 整形の種類。「ファイルの種類に合わせて」は種類ではなく入口の指定なので、`runFormat` の `'auto'` で表す。 */
export type FormatKind =
  | 'json'
  | 'jsonMinify'
  | 'html'
  | 'xml'
  | 'css'
  | 'js'
  | 'joinLines'
  | 'splitAt'
  | 'trimTrailing'
  | 'sortLines'
  | 'sortUnique'

/** 右クリックの整形メニューに並べる順（「ファイルの種類に合わせて」は別の行として先頭に出す）。 */
export const FORMAT_MENU: FormatKind[][] = [
  ['json', 'jsonMinify', 'html', 'xml', 'css', 'js'],
  ['joinLines', 'splitAt', 'trimTrailing'],
  ['sortLines', 'sortUnique'],
]

/** 行単位の整形（選択を行全体に広げるもの）。 */
const LINE_KINDS = new Set<FormatKind>(['trimTrailing', 'sortLines', 'sortUnique'])

/** ファイルの種別から、ファイルの種類に合わせた整形を決める。無ければ null。 */
export function autoFormatKind(fileType: string): FormatKind | null {
  // XML の仲間はラベルから導く（拡張子を並べると `fileType.ts` に足したときに漏れる）。
  if (fileType === 'svg' || (FILE_TYPE_LABELS as Record<string, string>)[fileType] === 'XML') return 'xml'
  switch (fileType) {
    case 'json':
    case 'jsonc':
      return 'json'
    // **Vue は入れない。** `<script lang="ts">` の中身が `js_beautify` に回り、下の TypeScript と
    // 同じ崩れ方をする（Pike 自身の SFC がこの形）。
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
    case 'scss':
    case 'less':
      return 'css'
    // **TypeScript は入れない。** `js-beautify` は型の構文を知らず、`Map<string, number[]>` を
    // `Map < string, number[] >` に崩す（実測）。キー 1 つで壊れたコードになるのは避ける。
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js'
    default:
      return null
  }
}

/**
 * 日本語・中国語の文字か（`joinLines` がつなぎ目に空白を入れるかの判定）。
 * `displayWidth.ts` の `isWideChar` は使わない: あちらは表示幅の判定でハングルと絵文字も
 * 含むが、ハングルは語のあいだに空白が要る。
 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/

/**
 * 改行を除いて 1 行にする。各行の前後の空白を落とし、**つなぎ目の両側が CJK でないときだけ
 * 空白 1 つ**でつなぐ（VS Code の Join Lines と同じく英文は語がくっつかないように、日本語は
 * 余計な空白が入らないように）。
 */
function joinLines(text: string): string {
  let out = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (out && !(CJK.test(out[out.length - 1]) || CJK.test(line[0]))) out += ' '
    out += line
  }
  return out
}

/** 指定した文字（列）のあとで改行する。区切りは行末に残し、改行の直後の空白は落とす。 */
function splitAt(text: string, delimiter: string): string {
  return text
    .split(delimiter)
    .map((part, i) => (i === 0 ? part : part.trimStart()))
    .join(`${delimiter}\n`)
}

/**
 * 行の並べ替えの比較。**数を数として比べる**（`item9` が `item10` より前。CSV プレビューの
 * 並べ替えと同じ考え方）。比較のたびに `localeCompare` を呼ぶと大きなファイルで遅いので、
 * 1 つ作って使い回す。
 */
const lineCollator = new Intl.Collator(undefined, { numeric: true })

function sortLines(text: string, unique: boolean): string {
  const lines = unique ? [...new Set(text.split('\n'))] : text.split('\n')
  return lines.sort(lineCollator.compare).join('\n')
}

/** JSON の空白（`JSON.parse` が読み飛ばす 4 種）。 */
function isJsonSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

/**
 * JSON の字下げと空白を付け直す。**値を解釈しない**（文字の並びを歩くだけ）ので、
 * `JSON.parse` と `JSON.stringify` の往復で起きる書き換えが無い: 2^53 を超える整数の精度落ち、
 * 重複したキーの片方が消える、`1.0` が `1` になる。構文の検査は呼び出し側が `JSON.parse` で済ませる。
 *
 * `indent` が 0 なら 1 行に詰める。空の `{}` / `[]` は開いたままにしない。
 * 文字列と、数値やリテラルの並びは `slice` でまとめて写す（50MB までのファイルを開けるので、
 * 1 文字ずつ正規表現や連結を回さない）。
 */
function reindentJson(text: string, indent: number): string {
  const pads: string[] = []
  const pad = (depth: number) => {
    if (indent === 0) return ''
    pads[depth] ??= `\n${' '.repeat(indent * depth)}`
    return pads[depth]
  }
  let out = ''
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      let k = i + 1
      while (k < text.length && isJsonSpace(text.charCodeAt(k))) k++
      if (text[k] === close) {
        out += c + close
        i = k + 1
      } else {
        depth++
        out += c + pad(depth)
        i++
      }
    } else if (c === '}' || c === ']') {
      depth--
      out += pad(depth) + c
      i++
    } else if (c === ',') {
      out += c + pad(depth)
      i++
    } else if (c === ':') {
      out += indent > 0 ? ': ' : ':'
      i++
    } else if (isJsonSpace(text.charCodeAt(i))) {
      i++
    } else {
      // 数値・`true`・`false`・`null` は区切りまでまとめて写す。
      let j = i + 1
      while (j < text.length && !isJsonSpace(text.charCodeAt(j)) && !',:]}'.includes(text[j])) j++
      out += text.slice(i, j)
      i = j
    }
  }
  return out
}

async function beautify(kind: 'html' | 'xml' | 'css' | 'js', text: string, indent: number): Promise<string> {
  // CommonJS のモジュールなので、読み込み方によって関数が `default` の下に入る
  // （Node の ESM と Vite の開発サーバーで答えが違う）。どちらでも引けるようにする。
  const mod = await import('js-beautify')
  const { html_beautify, css_beautify, js_beautify } = mod.default ?? mod
  const opts = { indent_size: indent, end_with_newline: false, preserve_newlines: true, max_preserve_newlines: 2 }
  if (kind === 'css') return css_beautify(text, opts)
  if (kind === 'js') return js_beautify(text, opts)
  // XML は HTML と同じ整形器に通す。HTML の既定（`pre` 等の中身を触らない、行を折り返さない）は
  // XML でも害が無く、XML 専用の整形器を足すほどの差が無い。
  return html_beautify(text, { ...opts, wrap_line_length: 0 })
}

/** 末尾に続く改行の数（後ろから数える。全文に正規表現をかけない）。 */
function trailingNewlines(text: string): number {
  let n = 0
  while (n < text.length && text.charCodeAt(text.length - 1 - n) === 10) n++
  return n
}

/**
 * `text` を整形した結果を返す。整形できなければ例外（文言は StatusBar にそのまま出す）。
 *
 * **末尾の改行は整形の外に置く**（外して整形し、同じものを付け直す）。ファイル全体を整形すると
 * 末尾の改行ごと整形器に渡ることになり、並べ替えでは空行が先頭へ移り、JSON や `js-beautify` は
 * 末尾の改行を落とす（保存のたびに EOF の差分が出る）。
 */
export async function formatText(kind: FormatKind, text: string, opts: { indent: number; delimiter?: string }) {
  const n = trailingNewlines(text)
  return (await formatBody(kind, text.slice(0, text.length - n), opts)) + '\n'.repeat(n)
}

async function formatBody(kind: FormatKind, text: string, opts: { indent: number; delimiter?: string }) {
  switch (kind) {
    case 'json':
    case 'jsonMinify':
      JSON.parse(text) // 構文の検査だけ（投げた例外の文言をそのまま出す）
      return reindentJson(text, kind === 'json' ? opts.indent : 0)
    case 'html':
    case 'xml':
    case 'css':
    case 'js':
      return beautify(kind, text, opts.indent)
    case 'joinLines':
      return joinLines(text)
    case 'splitAt':
      return splitAt(text, opts.delimiter ?? ',')
    case 'trimTrailing':
      return text.replace(/[ \t]+$/gm, '')
    case 'sortLines':
      return sortLines(text, false)
    case 'sortUnique':
      return sortLines(text, true)
  }
}

/**
 * 整形する範囲。選択があれば選択（行の整形は行全体に広げる）、無ければファイル全体。
 * **読み取り専用なら null**（`EditorState.readOnly` は dispatch を止めない）。
 */
function formatRange(view: EditorView, kind: FormatKind): { from: number; to: number } | null {
  if (view.state.readOnly) return null
  const { doc } = view.state
  const sel = view.state.selection.main
  if (sel.empty) return { from: 0, to: doc.length }
  if (!LINE_KINDS.has(kind)) return { from: sel.from, to: sel.to }
  // 行を上から下へドラッグして次の行の先頭で止めた選択は、その行を含まない。
  const last = doc.lineAt(sel.to)
  const end = last.from === sel.to && sel.to > sel.from ? doc.lineAt(sel.to - 1) : last
  return { from: doc.lineAt(sel.from).from, to: end.to }
}

function notify(text: string, variant: 'info' | 'warn' | 'error' = 'info', durationMs = 2500) {
  useStatusMessageStore().show({ text, variant, durationMs })
}

/**
 * 整形して置き換える。入口（右クリック・キー・パレット）はすべてここを通す。
 *
 * `fileType` は `'auto'` のときに何で整形するかを決める種別（手動の上書きがあればそれ）。
 *
 * - 整形器の読み込みを待つあいだに打たれていたら、古い本文を整形した結果で上書きしない
 * - 変わらなければ dispatch しない（Undo の履歴を汚さない）
 * - 選択範囲を整形したときは結果の全体を選択し直す（どこが変わったかが見え、続けて別の整形も
 *   かけられる）。ファイル全体のときはカーソルを先頭に置く
 */
export async function runFormat(view: EditorView, kind: FormatKind | 'auto', fileType: string) {
  const k = kind === 'auto' ? autoFormatKind(fileType) : kind
  if (!k) {
    notify(t('format.unsupported'), 'warn')
    return
  }
  let delimiter: string | undefined
  if (k === 'splitAt') {
    const answer = await promptDialog(t('format.splitPrompt'), ',')
    if (!answer) return
    delimiter = answer
  }
  const range = formatRange(view, k)
  if (!range) return
  const { doc } = view.state
  const wasSelection = !view.state.selection.main.empty
  const source = doc.sliceString(range.from, range.to)
  let result: string
  try {
    result = await formatText(k, source, { indent: useSettingsStore().editorTabSize, delimiter })
  } catch (e) {
    notify(t('format.failed', { error: e instanceof Error ? e.message : String(e) }), 'error', 4000)
    return
  }
  if (view.state.doc !== doc) return
  if (result === source) {
    notify(t('format.noChange'), 'info', 2000)
  } else {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: result },
      selection: wasSelection ? { anchor: range.from, head: range.from + result.length } : { anchor: 0 },
      userEvent: 'input.format',
      scrollIntoView: true,
    })
  }
  view.focus()
}
