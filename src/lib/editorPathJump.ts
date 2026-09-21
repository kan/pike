/**
 * エディタの中の `パス:行` を開く（タグジャンプ、#376）。
 *
 * 検索パネルの「結果をタブで開く」が書き出す grep の形（`src/a.ts:12: 内容`）を、
 * サクラエディタの grep 結果と同じく `Ctrl+Click` / F12 でその行へ飛べるようにする。
 * どのエディタのタブにも入るが、効くのは**行頭の `パス:行`** だけ（`pathLinkAt`）なので、
 * 保存した grep の結果や、同じ形のログでも使える。
 *
 * **判定は 2 本立て**（#376）。ターミナルの出力と同じ形は `findPathLinks`
 * （`lib/terminalLinks.ts`）で拾い、Pike 自身が書き出した形はここの `EXTRACT_LINE_RE` で
 * 受ける。**なぜ 1 本にしないかは `EXTRACT_LINE_RE` の doc が正本**（要点だけ: あちらは
 * 任意のターミナル出力という広い面を守っていて、拡張子と ASCII の縛りを緩めると誤爆が
 * そちらへ出る）。
 *
 * 代償として、拡張子の無いファイル名（`Makefile:12:`）と非 ASCII を含むパスは**エディタで
 * だけ押せる**。ターミナル側を揃えるなら `PATH_RE` の側を触ることになる。
 *
 * **定義ジャンプ（`editorJumpTo.ts`）より先に置く。** 押した位置にパスが無ければ何もせず
 * `false` を返し、定義ジャンプへ譲る。
 */
import { type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { hasMod } from './keys'
import { findPathLinks, type PathLinkTarget } from './terminalLinks'

/**
 * 書き出しの行の形（`パス:行: 本文`）。**`findPathLinks` が拾えないぶんを受ける**（#376）。
 *
 * あちらの `PATH_RE` は任意のターミナル出力が相手なので、誤爆を避けるために拡張子
 * （`\.\w{1,12}`）を必須にし、文字クラスも ASCII に閉じている。そのため
 * `Makefile:12:` / `Dockerfile:5:` / `.gitignore:2:` は 1 件も一致せず、非 ASCII を
 * 含むパス（`docs/設計/a.md:12:`）は非 ASCII の**後ろ**からしか一致しないので
 * `index === 0` に落ちる。タブのヘッダは「`Ctrl+Click` で開ける」と書いているのに、
 * 見た目が同じ行で黙って何も起きなかった。
 *
 * **`PATH_RE` を広げるのではなくこちらを足す。** あの規則はターミナルの出力という
 * ずっと広い面を守っていて、緩めると誤爆がそちらへ出る。
 *
 * **パスに空白と引用符を許さないこと。** `[^:]+` まで緩めると、ソースの
 * `let m = parse_grep_line("src/lib.rs:7:  …")` のような行が丸ごとパスとして一致する。
 * この拡張は `Prec.high` で定義ジャンプより前に走るので、そうなると識別子の
 * `Ctrl+Click` を横取りしたうえで `.catch` が失敗を飲み、**この変更が消そうとした
 * 「黙って何も起きない」を逆向きに作る**（この repo の追跡ファイルだけで 13 行が当たった）。
 * 空白を含むパスは `findPathLinks` 側も元から拾わないので、制限は揃っている。
 *
 * ドライブ文字だけは通し、それ以外にコロンを許さないので `https://example.com:8080:` の
 * ような行には当たらない。
 */
const EXTRACT_LINE_RE = /^((?:[A-Za-z]:)?[^\s:"'`]+):(\d+):/

/**
 * `pos` を含む `パス:行` を探す。**行頭から始まり、行番号を持つものだけ**（grep の出力の
 * 形）。行の途中のパスまで拾うと、`import Foo from './Foo.vue'` の `./Foo.vue` を
 * 定義ジャンプから横取りし、しかもファイルの場所ではなくルート基準で開いてしまう
 * （Markdown の `[x](../a.md)` も同じ）。
 */
function pathLinkAt(view: EditorView, pos: number): PathLinkTarget | null {
  const line = view.state.doc.lineAt(pos)
  const col = pos - line.from
  // 行番号付きかは、パスの直後が `:` かで見る（`findPathLinks` は行番号の無いパスにも
  // `line: 1` を入れて返すので、`line` の有無では分からない）。
  const hit = findPathLinks(line.text).find(
    (m) => m.index === 0 && line.text[m.path.length] === ':' && col >= m.index && col <= m.index + m.length,
  )
  if (hit) return hit
  const m = EXTRACT_LINE_RE.exec(line.text)
  if (!m) return null
  // 末尾の `:` は本文との区切りなので、押せる範囲に入れない。
  if (col > m[0].length - 1) return null
  return { path: m[1], line: Number(m[2]) }
}

export function editorPathJump(open: (target: PathLinkTarget) => void): Extension {
  return Prec.high([
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!hasMod(event)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const target = pathLinkAt(view, pos)
        if (!target) return false
        event.preventDefault()
        open(target)
        return true
      },
    }),
    keymap.of([
      {
        key: 'F12',
        run(view) {
          const target = pathLinkAt(view, view.state.selection.main.head)
          if (!target) return false
          open(target)
          return true
        },
      },
    ]),
  ])
}
