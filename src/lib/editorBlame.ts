/**
 * エディタの blame（#510）。表示は 2 つで、どちらも同じ `blameField` を読む。
 *
 * - **行末**：カーソルのある行の末尾に「作者, 3 日前 • 件名」を薄く出す（VS Code の
 *   blame の表示と同じ形）。設定で既定を決め、タブごとに右クリックで上書きできる
 * - **ガター**：ファイル全体の blame を行番号の隣に出す。同じコミットが続くかたまりの
 *   先頭の行にだけ作者と日時を書く
 *
 * どちらもホバーで詳細を出し、クリックでコミットタブを開く。
 *
 * **blame は保存済みのファイルに対して取る**（理由は Rust の `git/blame.rs`）。取ったあとの
 * 編集は、行頭に置いた印（`LineMark`）を CodeMirror の変更でずらして追いかけ、**触った行は
 * 「未コミット」にする**。打鍵のたびに git を走らせない。
 *
 * **取得を待つあいだの編集も落とさない。** 要求した時点の文書と、それ以降の変更を
 * `pending` に持ち、届いた結果をその変更でずらしてから載せる。
 */
import {
  ChangeSet,
  type EditorState,
  type Extension,
  MapMode,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { t } from '../i18n'
import type { BlameCommit, GitBlame } from '../types/git'
import { absoluteDate, relativeTime } from './paths'

/**
 * 行頭に置く印。`commit` は `BlameState.commits` の添字、`UNCOMMITTED` は保存後に触った行。
 *
 * **直後の文字（その行の先頭）が消えたら印も消える**（`TrackAfter`）。行をまるごと消したとき、
 * 消えた行の印が次の行の頭へ寄って 2 つ重なるのを防ぐ。行頭に文字を足したときは、印は足した
 * 文字の後ろへ動く（行頭で Enter を打つと、元の行の印は 1 行下がる）。
 */
class LineMark extends RangeValue {
  constructor(readonly commit: number) {
    super()
    this.mapMode = MapMode.TrackAfter
  }
  eq(other: RangeValue): boolean {
    return other instanceof LineMark && other.commit === this.commit
  }
}

const UNCOMMITTED = -1
const uncommittedMark = new LineMark(UNCOMMITTED)

/** 保存したあとに触った行。git の「未コミット」（ハッシュが 0）と同じに見せる。 */
const EDITED: BlameCommit = { hash: '', author: '', time: 0, summary: '', uncommitted: true }

interface BlameState {
  commits: readonly BlameCommit[]
  marks: RangeSet<LineMark>
  /** 取得中の要求。要求した時点の文書と、それ以降に入った変更を持つ。 */
  pending: { id: number; doc: Text; changes: ChangeSet } | null
}

/** 取得を始める（`id` は呼び出し側の通し番号。結果の取り違えを防ぐ）。 */
export const requestBlame = StateEffect.define<number>()
/** 取得した結果を載せる。`blame` が `null` なら、追跡外などで blame が無い。 */
export const setBlame = StateEffect.define<{ id: number; blame: GitBlame | null }>()

/**
 * 結果を、要求した時点の文書の行頭に並べる。**行数が合わなければ捨てる**（`null`）。
 * 保存してからディスクのファイルが書き換わった（外部の変更）ときに起きる。ファイルが改行で
 * 終わると、文書は blame より 1 行多い（末尾の空行）。
 */
function buildMarks(doc: Text, blame: GitBlame): RangeSet<LineMark> | null {
  const n = blame.lines.length
  const trailingEmpty = doc.lines === n + 1 && doc.line(doc.lines).length === 0
  if (doc.lines !== n && !trailingEmpty && !(n === 0 && doc.length === 0)) return null
  const builder = new RangeSetBuilder<LineMark>()
  const marks = blame.commits.map((_, i) => new LineMark(i))
  for (let i = 0; i < n; i++) builder.add(doc.line(i + 1).from, doc.line(i + 1).from, marks[blame.lines[i]])
  return builder.finish()
}

/**
 * 変更で触った行を「未コミット」にする。`oldDoc` / `doc` は変更の前と後の文書。
 *
 * **行をまるごと足した・消しただけなら、元の行は触っていない。** 行末で Enter を打てば新しい
 * 行は下に、行頭で打てば上にできる。どちらも未コミットにするのは新しい行だけ。行を改行ごと
 * 消したときは、どの行も未コミットにしない。**どちらかは変更の前の文書で決める**: 後の文書だけ
 * だと、空行ができる位置で行末と行頭の見分けがつかない。
 */
function markEdited(marks: RangeSet<LineMark>, changes: ChangeSet, oldDoc: Text, doc: Text): RangeSet<LineMark> {
  const starts: number[] = []
  let filterFrom = doc.length
  let filterTo = 0
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    let first = doc.lineAt(fromB).number
    let last = doc.lineAt(toB).number
    const at = oldDoc.lineAt(fromA)
    if (fromA === toA) {
      // 足しただけ。改行で終わる文字を行頭に足せば下の行は、改行で始まる文字を行末に足せば
      // 上の行は、元のまま。**行頭を先に見る**: 空行では行頭と行末が同じ位置で、元の行の印は
      // 足した文字の後ろへ動く（`TrackAfter`）ので、新しい行は上にできたことになる。
      if (fromA === at.from && inserted.sliceString(inserted.length - 1) === '\n') last -= 1
      else if (fromA === at.to && inserted.sliceString(0, 1) === '\n') first += 1
    } else if (inserted.length === 0) {
      // 消しただけ。行頭から行頭まで（`b\n`）か、行末から行末まで（`\nb`）なら行ごと消えた。
      const end = oldDoc.lineAt(toA)
      if ((fromA === at.from && toA === end.from) || (fromA === at.to && toA === end.to)) return
    }
    if (first > last) return
    filterFrom = Math.min(filterFrom, doc.line(first).from)
    filterTo = Math.max(filterTo, doc.line(last).to)
    for (let n = first; n <= last; n++) starts.push(doc.line(n).from)
  })
  if (starts.length === 0) return marks
  const edited = new Set(starts)
  return marks.update({
    filterFrom,
    filterTo,
    // 行の途中に残った印も落とす（行を連結すると、消えた行の印が行の中に入り込む）。
    filter: (from) => !edited.has(doc.lineAt(from).from),
    // 変更が複数あると、行頭が前後して並ぶことがある（`add` は昇順を求める）。
    add: [...edited].sort((a, b) => a - b).map((pos) => uncommittedMark.range(pos)),
  })
}

export const blameField = StateField.define<BlameState>({
  create: () => ({ commits: [], marks: RangeSet.empty, pending: null }),
  update(value, tr) {
    let { commits, marks, pending } = value
    if (tr.docChanged) {
      // blame がまだ無いうちは印も無いので、ずらすものが無い。
      if (commits.length > 0) marks = markEdited(marks.map(tr.changes), tr.changes, tr.startState.doc, tr.state.doc)
      if (pending) pending = { ...pending, changes: pending.changes.compose(tr.changes) }
    }
    for (const e of tr.effects) {
      if (e.is(requestBlame)) {
        pending = { id: e.value, doc: tr.state.doc, changes: ChangeSet.empty(tr.state.doc.length) }
      } else if (e.is(setBlame) && pending?.id === e.value.id) {
        const built = e.value.blame ? buildMarks(pending.doc, e.value.blame) : RangeSet.empty
        if (built) {
          commits = e.value.blame?.commits ?? []
          marks = markEdited(built.map(pending.changes), pending.changes, pending.doc, tr.state.doc)
        }
        pending = null
      }
    }
    if (commits === value.commits && marks === value.marks && pending === value.pending) return value
    return { commits, marks, pending }
  },
})

/** 取得済みの blame があるか（まだ取っていない・追跡外のファイルでは偽）。 */
export function hasBlame(state: EditorState): boolean {
  const field = state.field(blameField, false)
  return !!field && field.commits.length > 0
}

/** `line`（1 始まり）のコミット。blame が無ければ `null`。 */
export function blameAt(state: EditorState, line: number): BlameCommit | null {
  const field = state.field(blameField, false)
  if (!field || field.commits.length === 0) return null
  const pos = state.doc.line(line).from
  let found: number | null = null
  field.marks.between(pos, pos, (from, _to, mark) => {
    if (from !== pos) return
    found = mark.commit
    return false
  })
  if (found === null) return null
  return found === UNCOMMITTED ? EDITED : (field.commits[found] ?? null)
}

/**
 * 同じコミットが続くかたまりの先頭の行か（ガターはそこにだけ書く）。**コミットは同じ
 * オブジェクトを指す**（`commits` の要素か `EDITED`）ので、参照で比べてよい。
 */
function startsRun(state: EditorState, line: number, commit: BlameCommit): boolean {
  return line === 1 || blameAt(state, line - 1) !== commit
}

/** 行末とガターに出す 1 行。 */
function inlineText(c: BlameCommit): string {
  if (c.uncommitted) return t('blame.uncommitted')
  return `${c.author}, ${relativeTime(c.time * 1000)} • ${c.summary}`
}

// --- ホバーの詳細 ---------------------------------------------------------------

/** ホバー中の位置（ツールチップを出す位置で、その行の blame を出す）。 */
const setHover = StateEffect.define<number | null>()

function renderDetails(c: BlameCommit): HTMLElement {
  const dom = document.createElement('div')
  // `popup-surface` は背景の透過・アクリル（#162）の下でも読めるようにする共有クラス。
  dom.className = 'cm-blame-tooltip popup-surface'
  const add = (cls: string, text: string) => {
    const el = document.createElement('div')
    el.className = cls
    el.textContent = text
    dom.appendChild(el)
  }
  if (c.uncommitted) {
    add('cm-blame-tooltip-summary', t('blame.uncommittedDetail'))
    return dom
  }
  add('cm-blame-tooltip-summary', c.summary)
  add('cm-blame-tooltip-meta', `${c.author} · ${absoluteDate(new Date(c.time * 1000).toISOString())}`)
  add('cm-blame-tooltip-meta', `${c.hash.slice(0, 8)} · ${t('blame.clickToOpen')}`)
  return dom
}

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHover)) return e.value
    // 打てば位置がずれるので、いったん消す（次にマウスが動いたら出し直る）。
    // カーソルが動いたときも消す: 行末の表示はカーソルの行に付き替わり、消えた表示からは
    // `mouseleave` が届かない。
    return tr.docChanged || tr.selection ? null : value
  },
  provide: (f) =>
    showTooltip.computeN([f, blameField], (state): readonly (Tooltip | null)[] => {
      const pos = state.field(f)
      if (pos === null) return []
      const commit = blameAt(state, state.doc.lineAt(pos).number)
      if (!commit) return []
      return [{ pos, above: false, arrow: false, create: () => ({ dom: renderDetails(commit) }) }]
    }),
})

/** ホバーの位置が変わったときだけ dispatch する（`mousemove` は 1 ピクセルごとに来る）。 */
function hoverAt(view: EditorView, pos: number | null) {
  const cur = view.state.field(hoverField, false)
  if (cur === undefined || cur === pos) return
  view.dispatch({ effects: setHover.of(pos) })
}

// --- 行末 ---------------------------------------------------------------------

class InlineBlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly line: number,
    readonly hash: string | null,
    readonly open: (hash: string) => void,
  ) {
    super()
  }
  eq(other: InlineBlameWidget): boolean {
    return other.text === this.text && other.line === this.line && other.hash === this.hash
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-blame-inline'
    el.textContent = this.text
    // 位置は入ったときに DOM から引く（同じ表示のまま行の長さが変わると、DOM が使い回される）。
    el.addEventListener('mouseenter', () => hoverAt(view, view.posAtDOM(el)))
    el.addEventListener('mouseleave', () => hoverAt(view, null))
    if (this.hash) {
      const hash = this.hash
      el.classList.add('cm-blame-link')
      // **mousedown で開く。** click まで待つと、その前に CodeMirror がカーソルを移して
      // 行末の表示ごと作り直すので、click が届かない。
      el.addEventListener('mousedown', (e) => {
        // 左ボタンだけ（右クリックはエディタのメニューに渡す）。
        if (e.button !== 0) return
        e.preventDefault()
        hoverAt(view, null)
        this.open(hash)
      })
    }
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

function inlinePlugin(open: (hash: string) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view.state)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.startState.field(blameField) !== u.state.field(blameField)) {
          this.decorations = this.build(u.state)
        }
      }
      build(state: EditorState): DecorationSet {
        const line = state.doc.lineAt(state.selection.main.head)
        const commit = blameAt(state, line.number)
        if (!commit) return Decoration.none
        const widget = new InlineBlameWidget(
          inlineText(commit),
          line.number,
          commit.uncommitted ? null : commit.hash,
          open,
        )
        return Decoration.set([Decoration.widget({ widget, side: 1 }).range(line.to)])
      }
    },
    { decorations: (v) => v.decorations },
  )
}

// --- ガター -------------------------------------------------------------------

class BlameGutterMarker extends GutterMarker {
  constructor(readonly text: string) {
    super()
  }
  eq(other: BlameGutterMarker): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-blame-gutter-text'
    el.textContent = this.text
    return el
  }
}

function gutterText(c: BlameCommit): string {
  if (c.uncommitted) return t('blame.uncommittedShort')
  return `${relativeTime(c.time * 1000)}  ${c.author}`
}

/**
 * ガター。**同じコミットが続くかたまりの先頭の行にだけ書く**（全行に書くと読めない）。
 *
 * **見えている行だけを描く**（`lineMarker`）。ファイル全体の印の集合を組むと、打鍵のたびに
 * 全行を歩くことになる（編集で `blameField` が変わるので、作り直しを省けない）。
 */
function blameGutter(open: (hash: string) => void) {
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from).number
      const commit = blameAt(view.state, line)
      if (!commit || !startsRun(view.state, line, commit)) return null
      return new BlameGutterMarker(gutterText(commit))
    },
    lineMarkerChange: (u) => u.startState.field(blameField) !== u.state.field(blameField),
    domEventHandlers: {
      mousemove(view, block) {
        hoverAt(view, block.from)
        return false
      },
      mouseleave(view) {
        hoverAt(view, null)
        return false
      },
      mousedown(view, block, event) {
        // 左ボタンだけ（右クリックはエディタのメニューに渡す）。
        if ((event as MouseEvent).button !== 0) return false
        const commit = blameAt(view.state, view.state.doc.lineAt(block.from).number)
        if (!commit || commit.uncommitted) return false
        hoverAt(view, null)
        open(commit.hash)
        return true
      },
    },
  })
}

const blameTheme = EditorView.baseTheme({
  '.cm-blame-inline': {
    marginLeft: '3em',
    color: 'var(--text-secondary)',
    opacity: '0.75',
    fontStyle: 'italic',
    whiteSpace: 'pre',
  },
  '.cm-blame-link': { cursor: 'pointer' },
  '.cm-blame-gutter .cm-gutterElement': {
    width: '24ch',
    padding: '0 8px 0 4px',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  '.cm-blame-gutter-text': {
    color: 'var(--text-secondary)',
    fontSize: '90%',
    whiteSpace: 'pre',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-blame-tooltip': {
    maxWidth: '60vw',
    padding: '6px 10px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    // マウスは行末の表示かガターの上にあるあいだだけ出しているので、当たり判定は要らない
    // （本文に重なるぶん、持たせると下のテキストを選べなくなる）。
    pointerEvents: 'none',
    fontFamily: 'inherit',
  },
  '.cm-blame-tooltip-summary': { color: 'var(--text-primary)', whiteSpace: 'pre-wrap' },
  '.cm-blame-tooltip-meta': { color: 'var(--text-secondary)', fontSize: '90%', marginTop: '2px' },
})

export interface BlameOptions {
  inline: boolean
  gutter: boolean
  /** コミットタブを開く。 */
  open: (hash: string) => void
}

/**
 * blame の拡張。**どちらの表示も要らなければ空**（blame も取らない）。
 *
 * `blameField` はモジュールに 1 つなので、compartment で表示を入れ替えても、どちらかが
 * 残っていれば取得済みの blame は保たれる。
 */
export function editorBlame(opts: BlameOptions): Extension {
  if (!opts.inline && !opts.gutter) return []
  return [
    blameField,
    hoverField,
    blameTheme,
    opts.inline ? inlinePlugin(opts.open) : [],
    opts.gutter ? blameGutter(opts.open) : [],
  ]
}
