/**
 * 部分読み込み（#362）の「続きを読む」を本文の末尾に出す。
 *
 * **押したときだけ読む。** 末尾までスクロールしたら自動で読む形は採らない: スクロールしただけで
 * 数 MB ずつ読み込みとメモリが増えていく。上部のバー（EditorTab.vue）にも同じボタンがあり、
 * こちらは末尾まで読み進めた人のための 2 つ目の入口。
 *
 * 行はブロックの widget で、文書の末尾（`doc.length`）に置く。続きを足すと文書が伸びるので、
 * 位置は文書が変わるたびに作り直す。ラベル（残りの大きさ・読み込み中）が変わったときは、
 * 呼び出し側が compartment ごと張り直す。
 */
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

export interface LoadMoreRow {
  label: string
  busy: boolean
  onClick: () => void
}

class LoadMoreWidget extends WidgetType {
  constructor(private readonly row: LoadMoreRow) {
    super()
  }

  eq(other: LoadMoreWidget): boolean {
    return other.row.label === this.row.label && other.row.busy === this.row.busy
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-load-more'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-load-more-btn'
    btn.textContent = this.row.label
    btn.disabled = this.row.busy
    btn.addEventListener('click', this.row.onClick)
    wrap.append(btn)
    return wrap
  }

  // ボタンのクリックをエディタに渡さない（カーソル移動や選択にしない）。
  ignoreEvent(): boolean {
    return true
  }
}

const theme = EditorView.baseTheme({
  // **ブラウザのスクロールアンカーに選ばせない。** 押した直後は画面に残っているのがこの行だけなので、
  // 選ばれると、前に足した本文のぶんだけスクロールが送られてこの行（＝新しい末尾）へ飛ぶ。
  '.cm-load-more': { padding: '12px 0 16px 4px', overflowAnchor: 'none' },
  '.cm-load-more-btn': {
    padding: '4px 14px',
    border: '1px solid var(--accent)',
    borderRadius: '4px',
    background: 'var(--accent)',
    color: 'var(--text-active)',
    fontFamily: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
  },
  '.cm-load-more-btn:disabled': { opacity: '0.6', cursor: 'default' },
})

/** 行を出すときだけ拡張を返す（`null` なら何も足さない）。 */
export function loadMoreRow(row: LoadMoreRow | null): Extension {
  if (!row) return []
  const widget = new LoadMoreWidget(row)
  // 文書が伸びたら末尾の位置で作り直す。
  const decorations = EditorView.decorations.compute(['doc'], (state) =>
    Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(state.doc.length)]),
  )
  return [decorations, theme]
}
