import { EditorState, type Extension, RangeSetBuilder, StateField, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Panel,
  showPanel,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { t } from '../i18n'

// Git conflict markers are exactly 7 characters, optionally followed by a label.
const START = /^<{7}(?:\s|$)/ // <<<<<<< ours
const BASE = /^\|{7}(?:\s|$)/ // ||||||| base (diff3 style)
const SEP = /^={7}(?:\s|$)/ //  ======= separator
const END = /^>{7}(?:\s|$)/ //  >>>>>>> theirs

/** Which side of a conflict to keep. */
type ConflictSide = 'ours' | 'theirs' | 'both'

type LineKind = 'ours-marker' | 'base-marker' | 'sep-marker' | 'theirs-marker' | 'ours' | 'base' | 'theirs'

const LINE_DECORATION: Record<LineKind, Decoration> = {
  'ours-marker': Decoration.line({ class: 'cm-conflict-ours-marker' }),
  'base-marker': Decoration.line({ class: 'cm-conflict-base-marker' }),
  'sep-marker': Decoration.line({ class: 'cm-conflict-sep-marker' }),
  'theirs-marker': Decoration.line({ class: 'cm-conflict-theirs-marker' }),
  ours: Decoration.line({ class: 'cm-conflict-ours' }),
  base: Decoration.line({ class: 'cm-conflict-base' }),
  theirs: Decoration.line({ class: 'cm-conflict-theirs' }),
}

/** One `<<<<<<< / ======= / >>>>>>>` region, parsed once per document change. */
interface Conflict {
  /** Start of the `<<<<<<<` line. */
  from: number
  /** End of the region's last line, marker included. */
  to: number
  /** Every line of the region with the tint it gets; decorations read only this. */
  lines: { at: number; kind: LineKind }[]
  ours: string
  theirs: string
  /** Label after the marker (`HEAD`, a branch name); empty when git omitted it. */
  oursLabel: string
  theirsLabel: string
  /** Both a `=======` and a `>>>>>>>` closed it, so it can be rewritten whole.
   *  A region still being typed keeps its highlight but gets no buttons. */
  complete: boolean
}

interface Draft extends Conflict {
  section: 'ours' | 'base' | 'theirs'
  oursLines: string[]
  theirsLines: string[]
  sawSep: boolean
}

function startDraft(at: number, to: number, text: string): Draft {
  return {
    from: at,
    to,
    lines: [{ at, kind: 'ours-marker' }],
    ours: '',
    theirs: '',
    oursLabel: text.slice(7).trim(),
    theirsLabel: '',
    complete: false,
    section: 'ours',
    oursLines: [],
    theirsLines: [],
    sawSep: false,
  }
}

function finishDraft(draft: Draft): Conflict {
  draft.ours = draft.oursLines.join('\n')
  draft.theirs = draft.theirsLines.join('\n')
  return draft
}

/**
 * Every conflict region in the document, in one linear pass. `iterLines` walks
 * the rope once instead of an O(log N) descent per line, which matters because
 * this runs on every edit of every open file.
 */
function parseConflicts(doc: Text): Conflict[] {
  const found: Conflict[] = []
  let draft: Draft | null = null
  let pos = 0

  for (const text of doc.iterLines()) {
    const at = pos
    const to = at + text.length
    pos = to + 1

    if (START.test(text)) {
      // An unterminated region ends where the next one begins.
      if (draft) found.push(finishDraft(draft))
      draft = startDraft(at, to, text)
    } else if (!draft) {
      // An ordinary line outside any region.
    } else if (BASE.test(text)) {
      draft.lines.push({ at, kind: 'base-marker' })
      draft.section = 'base'
      draft.to = to
    } else if (SEP.test(text)) {
      draft.lines.push({ at, kind: 'sep-marker' })
      draft.section = 'theirs'
      draft.sawSep = true
      draft.to = to
    } else if (END.test(text)) {
      draft.lines.push({ at, kind: 'theirs-marker' })
      draft.theirsLabel = text.slice(7).trim()
      draft.complete = draft.sawSep
      draft.to = to
      found.push(finishDraft(draft))
      draft = null
    } else {
      draft.lines.push({ at, kind: draft.section })
      draft.to = to
      // The base section belongs to neither side, so nobody collects it.
      if (draft.section === 'ours') draft.oursLines.push(text)
      else if (draft.section === 'theirs') draft.theirsLines.push(text)
    }
  }
  if (draft) found.push(finishDraft(draft))
  return found
}

/** Parsed once per changed transaction; the decorations, the panel and the
 *  widgets all read this rather than walking the document again. */
const conflictField = StateField.define<Conflict[]>({
  create: (state) => parseConflicts(state.doc),
  update: (value, tr) => (tr.docChanged ? parseConflicts(tr.newDoc) : value),
})

function resolvedText(conflict: Conflict, side: ConflictSide): string {
  if (side === 'ours') return conflict.ours
  if (side === 'theirs') return conflict.theirs
  if (!conflict.ours) return conflict.theirs
  if (!conflict.theirs) return conflict.ours
  return `${conflict.ours}\n${conflict.theirs}`
}

/**
 * Replace whole conflict regions with the chosen side, in one transaction so a
 * single undo puts the markers back — including after a whole-file apply.
 * Keeping an empty side would otherwise leave a blank line behind, so the
 * region's own line break goes with it.
 */
function resolve(view: EditorView, conflicts: Conflict[], side: ConflictSide) {
  const changes = conflicts
    .filter((conflict) => conflict.complete)
    .map((conflict) => {
      const insert = resolvedText(conflict, side)
      const from = !insert && conflict.from > 0 ? conflict.from - 1 : conflict.from
      return { from, to: conflict.to, insert }
    })
  if (changes.length === 0) return
  view.dispatch({ changes, userEvent: 'input.conflict' })
  view.focus()
}

function button(label: string, onClick: () => void, title = ''): HTMLButtonElement {
  const el = document.createElement('button')
  el.className = 'cm-conflict-btn'
  el.type = 'button'
  el.textContent = label
  if (title && title !== label) el.title = title
  el.addEventListener('click', onClick)
  return el
}

/** Git writes whatever names the sides, and for a rebase that is the whole
 *  `1cb6fb9 (feat side)` — too wide for a button, so the full text goes to the
 *  tooltip. */
const MAX_LABEL_CHARS = 24

function sideButton(label: string, fallback: string, onClick: () => void): HTMLButtonElement {
  if (!label) return button(fallback, onClick)
  const short = label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label
  return button(t('git.conflictTake', { label: short }), onClick, t('git.conflictTake', { label }))
}

/** The action row drawn above each `<<<<<<<` line. */
class ConflictActions extends WidgetType {
  constructor(
    private readonly index: number,
    private readonly oursLabel: string,
    private readonly theirsLabel: string,
  ) {
    super()
  }

  // Deliberately not comparing offsets: those shift whenever anything above is
  // typed, which would rebuild every row below the caret on every keystroke.
  eq(other: ConflictActions): boolean {
    return other.index === this.index && other.oursLabel === this.oursLabel && other.theirsLabel === this.theirsLabel
  }

  toDOM(view: EditorView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cm-conflict-actions'
    // Read the region at click time: the row outlives edits above it, so its
    // own offsets would be stale by then.
    const apply = (side: ConflictSide) => () => {
      const conflict = view.state.field(conflictField)[this.index]
      if (conflict) resolve(view, [conflict], side)
    }
    const ours = sideButton(this.oursLabel, t('git.conflictOurs'), apply('ours'))
    ours.classList.add('cm-conflict-btn-primary')
    row.append(
      ours,
      sideButton(this.theirsLabel, t('git.conflictTheirs'), apply('theirs')),
      button(t('git.conflictBoth'), apply('both')),
    )
    return row
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  state.field(conflictField).forEach((conflict, index) => {
    // A block widget sorts before the line decoration at the same offset, so it
    // has to be added first to keep the builder's ranges ascending.
    if (conflict.complete && !state.readOnly) {
      builder.add(
        conflict.from,
        conflict.from,
        Decoration.widget({
          widget: new ConflictActions(index, conflict.oursLabel, conflict.theirsLabel),
          block: true,
          side: -1,
        }),
      )
    }
    for (const line of conflict.lines) builder.add(line.at, line.at, LINE_DECORATION[line.kind])
  })
  return builder.finish()
}

/** Top bar with the conflict count and the two whole-file actions. */
function conflictPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-conflict-panel'
  const count = document.createElement('span')
  count.className = 'cm-conflict-count'
  const applyAll = (side: ConflictSide) => () => resolve(view, view.state.field(conflictField), side)
  const actions = document.createElement('div')
  actions.className = 'cm-conflict-panel-actions'
  // Built once: the handlers read the current parse, so only the count changes.
  actions.append(
    button(t('git.conflictAllOurs'), applyAll('ours')),
    button(t('git.conflictAllTheirs'), applyAll('theirs')),
  )
  dom.append(count, actions)

  const showCount = (state: EditorState) => {
    count.textContent = t('git.conflictCount', { count: state.field(conflictField).length })
  }
  showCount(view.state)

  return {
    dom,
    top: true,
    update(update: ViewUpdate) {
      if (update.docChanged) showCount(update.state)
    },
  }
}

// Translucent overlays so the colors read on both light and dark themes.
const conflictTheme = EditorView.baseTheme({
  '.cm-conflict-ours': { backgroundColor: 'rgba(46, 160, 67, 0.12)' },
  '.cm-conflict-base': { backgroundColor: 'rgba(150, 150, 150, 0.10)' },
  '.cm-conflict-theirs': { backgroundColor: 'rgba(56, 139, 253, 0.12)' },
  '.cm-conflict-ours-marker': { backgroundColor: 'rgba(46, 160, 67, 0.32)', fontWeight: 'bold' },
  '.cm-conflict-base-marker': { backgroundColor: 'rgba(150, 150, 150, 0.28)', fontWeight: 'bold' },
  '.cm-conflict-sep-marker': { backgroundColor: 'rgba(210, 153, 34, 0.32)', fontWeight: 'bold' },
  '.cm-conflict-theirs-marker': { backgroundColor: 'rgba(56, 139, 253, 0.32)', fontWeight: 'bold' },
  '.cm-conflict-actions': { display: 'flex', gap: '6px', padding: '2px 0 2px 4px' },
  // Same shape as the external-change bar in EditorTab.vue, so the two do not
  // clash when a file is both conflicted and changed on disk.
  '.cm-conflict-panel': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
  },
  '.cm-conflict-count': { flex: '1', fontSize: '12px', color: 'var(--text-secondary)' },
  '.cm-conflict-panel-actions': { display: 'flex', gap: '6px' },
  '.cm-conflict-btn': {
    padding: '2px 8px',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    font: 'inherit',
    fontSize: '11px',
    cursor: 'pointer',
  },
  // An accent fill on hover, like the other panel buttons — a brightness filter
  // barely reads against the light theme's near-white surfaces.
  '.cm-conflict-btn:hover': {
    background: 'var(--accent)',
    color: 'var(--text-active)',
    borderColor: 'transparent',
  },
  '.cm-conflict-btn-primary': {
    borderColor: 'transparent',
    background: 'var(--accent)',
    color: 'var(--text-active)',
  },
})

/**
 * Highlights git conflict regions (`<<<<<<<` / `=======` / `>>>>>>>`, plus the
 * diff3 `|||||||` base section) and offers one-click resolution: a row of
 * take-this-side buttons above each region, and whole-file actions in a top bar
 * (#223). Resolving only rewrites the buffer — saving and staging stay where
 * they were, in `Ctrl+S` and the Git panel.
 *
 * Labels are read when the DOM is built, so `EditorTab` re-registers this
 * through a compartment when the UI language changes.
 */
export function conflictHighlight(): Extension {
  return [
    conflictField,
    EditorView.decorations.compute([conflictField, EditorState.readOnly], buildDecorations),
    // The bar is worth its vertical space only while there is something to fix.
    showPanel.compute([conflictField, EditorState.readOnly], (state) =>
      state.field(conflictField).length > 0 && !state.readOnly ? conflictPanel : null,
    ),
    conflictTheme,
  ]
}
