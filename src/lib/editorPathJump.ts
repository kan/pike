/**
 * エディタの中の `パス:行` を開く（タグジャンプ、#376）。
 *
 * 検索パネルの「結果をタブで開く」が書き出す grep の形（`src/a.ts:12: 内容`）を、
 * サクラエディタの grep 結果と同じく `Ctrl+Click` / F12 でその行へ飛べるようにする。
 * どのエディタのタブにも入るが、効くのは**行頭の `パス:行`** だけ（`pathLinkAt`）なので、
 * 保存した grep の結果や、同じ形のログでも使える。
 *
 * **判定はターミナルと同じ `findPathLinks`**（`lib/terminalLinks.ts`）。出力の中のパスを
 * 拾う規則が 2 つあると、ターミナルでは押せるのにエディタでは押せない、が起きる。
 *
 * **定義ジャンプ（`editorJumpTo.ts`）より先に置く。** 押した位置にパスが無ければ何もせず
 * `false` を返し、定義ジャンプへ譲る。
 */
import { type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { hasMod } from './keys'
import { findPathLinks, type PathLinkTarget } from './terminalLinks'

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
  return hit ?? null
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
