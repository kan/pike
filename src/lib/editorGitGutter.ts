import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { EditorView, GutterMarker, gutter, showTooltip, type Tooltip } from '@codemirror/view'
import { t } from '../i18n'
import type { GitDiffLines, RemovedBlock } from './tauri'

class AddedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-git-added'
    return el
  }
}

class ModifiedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-git-modified'
    return el
  }
}

class DeletedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-git-deleted'
    return el
  }
}

const addedMarker = new AddedMarker()
const modifiedMarker = new ModifiedMarker()
const deletedMarker = new DeletedMarker()

export const setDiffLines = StateEffect.define<GitDiffLines>()

export interface DiffData {
  added: Set<number>
  modified: Set<number>
  deleted: Set<number>
  /**
   * 行 → その行にホバーしたときに見せる「消えた行」（#322）。**変更範囲は全行に同じ
   * かたまりを張る**（Rust は開始行にしか紐付けない）ので、引く側は 1 回の `get` で済む。
   * 追加だけの行は持たない＝ツールチップも出ない。
   */
  removed: Map<number, RemovedBlock>
}

function buildDiffData(diff: GitDiffLines): DiffData {
  const added = new Set<number>()
  const modified = new Set<number>()
  const deleted = new Set<number>()
  const removed = new Map<number, RemovedBlock>()
  for (const [start, end] of diff.added) {
    for (let i = start; i <= end; i++) added.add(i)
  }
  for (const line of diff.deleted) deleted.add(line)
  // **`removed` は範囲を回る前に入れる。** Rust は変更範囲の開始行にしか紐付けないので、
  // 範囲へ広げるのと同じ 1 パスで済ませられる（参照を共有するので複製にはならない）。
  for (const block of diff.removed) removed.set(block.line, block)
  for (const [start, end] of diff.modified) {
    const block = removed.get(start)
    for (let i = start; i <= end; i++) {
      modified.add(i)
      if (block) removed.set(i, block)
    }
  }
  return { added, modified, deleted, removed }
}

// Exported so minimap can read the same field without duplicating state
export const diffField = StateField.define<DiffData>({
  create() {
    return { added: new Set(), modified: new Set(), deleted: new Set(), removed: new Map() }
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffLines)) {
        return buildDiffData(effect.value)
      }
    }
    return value
  },
})

// Precompute RangeSet in a derived field so markers() is a cheap lookup
const gutterMarkers = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffLines)) {
        // **`diffField` の結果を読む**（同じ `buildDiffData` を 2 度走らせない）。
        // `gitDiffGutter()` があちらを先に並べているので、この時点で更新済み。
        const diff = tr.state.field(diffField)
        const doc = tr.state.doc
        const marks: ReturnType<GutterMarker['range']>[] = []
        for (let i = 1; i <= doc.lines; i++) {
          if (diff.added.has(i)) marks.push(addedMarker.range(doc.line(i).from))
          else if (diff.modified.has(i)) marks.push(modifiedMarker.range(doc.line(i).from))
          else if (diff.deleted.has(i)) marks.push(deletedMarker.range(doc.line(i).from))
        }
        return RangeSet.of(marks)
      }
    }
    return value
  },
})

/** ホバー中の行（1 始まり）。ガターから外れたら `null`。 */
const setHoverLine = StateEffect.define<number | null>()

/** 消えた行の一覧を組み立てる。**ツールチップは開くたびに作り直される**ので、`t()` を
 *  ここで呼んでも UI 言語の切り替えに追従する。 */
function renderRemoved(block: RemovedBlock): HTMLElement {
  const dom = document.createElement('div')
  // `popup-surface` は背景の透過・アクリル（#162）の下でも読めるようにするための共有クラス。
  dom.className = 'cm-git-removed popup-surface'
  for (const line of block.lines) {
    const row = document.createElement('div')
    row.className = 'cm-git-removed-line'
    // 空行でも高さを保つ（`textContent = ''` だと潰れる）。
    row.textContent = line === '' ? ' ' : line
    dom.appendChild(row)
  }
  if (block.total > block.lines.length) {
    const more = document.createElement('div')
    more.className = 'cm-git-removed-more'
    more.textContent = t('editor.removedMore', { n: String(block.total - block.lines.length) })
    dom.appendChild(more)
  }
  return dom
}

/**
 * ガターのインジケータをポイントしたときに、消えた行を出す（#322）。
 *
 * **出すのは `-` の側だけ。** `+` の側は今エディタに映っているので、並べると同じ内容が
 * 2 度出る。追加だけの行は持たないので、そこでは何も出ない。
 *
 * 位置は行頭の doc position。`removed` のキーには doc の外（**末尾の削除は最終行 + 1 に
 * 付く**）も入るが、ホバーで来る行は必ず doc 内なので実際には当たらない。clamp は引き方を
 * 変えたときのための防御。
 *
 * **ファイル末尾の行を消したときはツールチップが出ない。** ガターの印もそこには出ない
 * （`gutterMarkers` が最終行までしか置かない）ので、印とホバーで食い違うことはない。
 */
const hoverField = StateField.define<number | null>({
  create() {
    return null
  },
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHoverLine)) return effect.value
    // 打てば行がずれるので、いったん消す（次の mousemove で出し直る）。
    return tr.docChanged ? null : value
  },
  provide: (f) =>
    showTooltip.computeN([f, diffField], (state): readonly (Tooltip | null)[] => {
      const line = state.field(f)
      if (line == null) return []
      const block = state.field(diffField).removed.get(line)
      if (!block) return []
      const pos = state.doc.line(Math.min(line, state.doc.lines)).from
      return [{ pos, above: false, arrow: false, create: () => ({ dom: renderRemoved(block) }) }]
    }),
})

const gitGutter = gutter({
  class: 'cm-git-gutter',
  markers(view) {
    return view.state.field(gutterMarkers)
  },
  domEventHandlers: {
    // **同じ行なら dispatch しない。** `mousemove` は 1 ピクセル動くたびに来るので、
    // 素直に投げると state 更新とツールチップの作り直しが毎回走る。
    mousemove(view, block) {
      const line = view.state.doc.lineAt(block.from).number
      if (view.state.field(hoverField) !== line) {
        view.dispatch({ effects: setHoverLine.of(line) })
      }
      return false
    },
    // ガター要素そのものに addEventListener されるので、バブルしない `mouseleave` も届く
    // （CodeMirror の `gutter` の実装）。
    mouseleave(view) {
      if (view.state.field(hoverField) !== null) {
        view.dispatch({ effects: setHoverLine.of(null) })
      }
      return false
    },
  },
})

const gitGutterTheme = EditorView.baseTheme({
  '.cm-git-gutter': { width: '3px', minWidth: '3px' },
  '.cm-git-gutter .cm-gutterElement': { padding: '0', position: 'relative' },
  // **ポイントできる幅を左へ広げる（#322）。** 帯は 3px しかなく、そこへマウスを
  // 合わせるのは狙いすぎになる。**右（本文側）へは広げない**: 本文に重なると
  // テキストの選択を奪う。左は行番号ガターで、Pike はそこに何も割り当てていない。
  '.cm-git-gutter .cm-gutterElement::after': {
    content: '""',
    position: 'absolute',
    inset: '0 0 0 -6px',
  },
  '.cm-git-added': { width: '3px', height: '100%', background: '#2ea04370' },
  '.cm-git-modified': { width: '3px', height: '100%', background: '#d29922' },
  '.cm-git-deleted': {
    width: '0',
    height: '0',
    borderLeft: '4px solid transparent',
    borderRight: '4px solid transparent',
    borderTop: '4px solid #f85149',
    margin: '0 -2px',
  },
  // 消えた行のツールチップ（#322）。色は diff タブの削除行と同じ考え方で、赤を敷く。
  '.cm-git-removed': {
    maxWidth: '60vw',
    // 40 行（Rust 側の上限）が収まる高さ。**`auto` にしないこと**: ガターから離れると
    // 消えるので、出したスクロールバーは押せない。
    maxHeight: '70vh',
    overflow: 'hidden',
    // マウスはガターの上にあるあいだだけ出ているので、この矩形は当たり判定を持たなくて
    // よい（本文に重なるぶん、持たせると下のテキストを選べなくなる）。
    pointerEvents: 'none',
    padding: '4px 0',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    fontFamily: 'inherit',
    fontSize: '90%',
  },
  // 色は上のマーカーと同じ固定値を薄めたもの（このファイルの他の 3 つと同じ流儀）。
  '.cm-git-removed-line': {
    padding: '0 8px',
    whiteSpace: 'pre',
    background: '#f8514922',
    color: 'var(--text-primary)',
  },
  '.cm-git-removed-more': {
    padding: '2px 8px 0',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
})

export function gitDiffGutter() {
  return [diffField, gutterMarkers, gitGutter, hoverField, gitGutterTheme]
}
