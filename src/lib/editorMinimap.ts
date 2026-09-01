import { EditorView, ViewPlugin } from '@codemirror/view'
import { showMinimap } from '@replit/codemirror-minimap'
import { diffField } from './editorGitGutter'

/**
 * view ごとのミニマップ。`create()` はパッケージが呼ぶただのコールバックで、破棄のフックも
 * 持たないので、下の ViewPlugin へ要素とオブザーバを渡す口がここにしかない。
 */
const minimaps = new WeakMap<EditorView, { dom: HTMLElement; observer: ResizeObserver }>()

/**
 * ミニマップの器を作り、実幅を CSS 変数として `.cm-editor` へ書き出す（本文側の余白が読む）。
 *
 * 幅を CSS に固定できないのは、パッケージが実行時に決めるため（`Scale.MaxWidth`=120px を
 * 上限に、エディタ幅が 720px を切ると比例縮小する）。分割表示や狭いウィンドウでは、縮んだ
 * ぶんだけ余白が残って本文の右が無駄に空く。
 *
 * **幅と余白がループにならないのは、両者の出どころが違うから**。パッケージの `getWidth()` は
 * `.cm-editor` の幅を見るのに対し、余白を付けるのは `.cm-scroller` なので、余白を変えても
 * 測り直した幅は動かない。逆に言うと、変数を scroller の幅から出すとループする。
 */
function create(view: EditorView) {
  const dom = document.createElement('div')
  // 位置は theme ではなくインラインで持つ。パッケージ側の `position: sticky`（クラス）に
  // 詳細度で勝てるので `!important` が要らず、クラス名の取り合いにもならない。
  dom.style.cssText = 'position: absolute; top: 0; right: 0; height: 100%; border-left: 1px solid var(--border);'
  const observer = new ResizeObserver(([entry]) => {
    // 渡された値を使う（`offsetWidth` を読むと、複数のエディタが同時にリサイズされたとき
    // 直前のコールバックの書き込みで同期レイアウトが走る）。border-box なので上の枠線を含む。
    view.dom.style.setProperty('--minimap-width', `${entry.borderBoxSize[0].inlineSize}px`)
  })
  observer.observe(dom)
  minimaps.set(view, { dom, observer })
  return { dom }
}

/**
 * ミニマップを `.cm-editor` の直下へ移し、外れるときに後始末する（#282）。
 *
 * パッケージはミニマップを `.cm-scroller` の中へ `position: sticky; right: 0` で入れる
 * （`scrollDOM.insertBefore`）。一方 `.cm-content` の幅は最長行で決まりミニマップの存在を
 * 知らないので、折り返し OFF で長い行があると、**スクロールしていなくても**本文がその下を
 * 通る。scroller への `padding` では直らない: overflow のクリップは padding box で起きる
 * ので、はみ出した本文は padding の上にも描かれる。`.cm-content` の margin も同じで、本文の
 * 右に空白を足すだけで描画の範囲は変わらない。**scroller の可視領域そのものを狭める**必要が
 * ある。
 *
 * そこでミニマップを scroller の外（`.cm-editor` は base theme で `position: relative`）へ
 * 出し、scroller には `margin-right` を与える。`.cm-editor` は縦並びの flex なので、margin の
 * ぶんだけ scroller の幅が縮み、本文はその中でスクロールする。空いた右端がミニマップの居場所。
 *
 * **`.cm-scroller` の `position` は触らないこと。** あれを `static` にすれば containing block
 * が `.cm-editor` へ上がって同じ配置にできるが、CodeMirror 本体が `scrollDOM` へ直接ぶら下げる
 * `.cm-layer`（選択範囲・カーソル・drop cursor）は「scroller のスクロール済み座標系」を前提に
 * 座標を出すので、スクロールしたときに選択とカーソルが本文から剥がれて置き去りになる。Pike は
 * `drawSelection` も `dropCursor` も入れていないため今は表に出ないが、誰かが足した日にミニマップ
 * とは無関係に見える形で壊れる。
 *
 * 再親化してもパッケージは壊れない。オーバーレイは `view.dom.querySelector('.cm-minimap-inner')`
 * で辿り、撤去は `dom.remove()` で親を問わないため。依存しているのは「`create()` が返した要素を
 * そのまま使う」という 1 点だけで、そこが変わればミニマップが元の位置に戻るので目で分かる。
 */
const attach = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.reparent()
    }
    update() {
      this.reparent()
    }
    reparent() {
      const dom = minimaps.get(this.view)?.dom
      if (dom && dom.parentElement !== this.view.dom) this.view.dom.appendChild(dom)
    }
    destroy() {
      minimaps.get(this.view)?.observer.disconnect()
      minimaps.delete(this.view)
      this.view.dom.style.removeProperty('--minimap-width')
    }
  },
)

/**
 * 本文側の余白。既定値をパッケージの上限（120px）にしてあるのは、エディタを開いた最初の
 * 1 フレームで幅が 0 から跳ねると、scroller の再測定とともに本文がずれて見えるため。720px
 * より狭いエディタでは実測が来た時点で縮む。
 */
const layout = EditorView.theme({
  '.cm-scroller': { marginRight: 'var(--minimap-width, 120px)' },
})

export function minimap() {
  return [
    showMinimap.compute(['doc', diffField], (state) => {
      const diff = state.field(diffField, false)
      const gutters: Record<number, string>[] = []
      if (diff) {
        const gutter: Record<number, string> = {}
        for (const line of diff.added) gutter[line] = 'rgba(46, 160, 67, 0.7)'
        for (const line of diff.modified) gutter[line] = 'rgba(210, 153, 34, 0.7)'
        for (const line of diff.deleted) gutter[line] = 'rgba(248, 81, 73, 0.8)'
        gutters.push(gutter)
      }
      return {
        create,
        displayText: 'blocks' as const,
        showOverlay: 'always' as const,
        gutters,
      }
    }),
    layout,
    attach,
  ]
}
