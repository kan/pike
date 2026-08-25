/**
 * Markdown editing commands for the assist toolbar and its shortcuts (#241).
 *
 * Everything here is a single dispatch on an `EditorView`, so one click or one
 * shortcut is one undo step. The toolbar hands over a plain {@link MarkdownAction}
 * rather than calling in directly: the component then holds no editor state, and
 * the shortcuts and the buttons run the same code.
 *
 * Deliberately absent: continuing a list on Enter, renumbering as you type, and
 * turning a pasted URL into a link. `@codemirror/lang-markdown` already binds
 * those (`insertNewlineContinueMarkup` / `deleteMarkupBackward` at `Prec.high`,
 * plus `pasteURLAsLink`) whenever the file gets the Markdown language, so
 * re-implementing them here would fight the language extension for the key.
 */

import { type ChangeSpec, EditorSelection, type EditorState, type Line } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { t } from '../i18n'

/** Paired characters that wrap a span of text. */
type InlineMark = '**' | '*' | '~~' | '`'
/** Prefixes that own a whole line. */
type LineMarker = 'bullet' | 'ordered' | 'task' | 'quote'
/** Multi-line constructs inserted from a fixed template. */
type BlockKind = 'code' | 'hr' | 'details'

/** Shape of a table to insert. `rows` counts body rows, below the header. */
export interface TableSpec {
  rows: number
  cols: number
}

/** Text to insert, and the offsets inside it the caret should end up on. When
 *  the two differ the placeholder comes out selected, so the first keystroke
 *  replaces it. */
interface Template {
  text: string
  select: [number, number]
}

export type MarkdownAction =
  | { kind: 'inline'; mark: InlineMark }
  /** `level` 0 turns a heading back into a paragraph. */
  | { kind: 'heading'; level: number }
  | { kind: 'line'; marker: LineMarker }
  | { kind: 'block'; block: BlockKind }
  /** Its own kind, not a block: the shape is chosen before it is written. */
  | { kind: 'table'; spec: TableSpec }
  /** Its own kind, not a block: it writes in two places rather than one. */
  | { kind: 'footnote' }
  /** `url` pre-fills the target (e.g. a URL found on the clipboard). */
  | { kind: 'link'; url?: string }

/** A list item: bullet or number, optionally carrying a task checkbox. */
const LIST_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/
const QUOTE_RE = /^(\s*)>[ \t]?/
const HEADING_RE = /^(\s*)(#{1,6})[ \t]+/
const INDENT_RE = /^[ \t]*/
/** A selection that is a bare link target rather than text to be linked. */
const URL_LIKE_RE = /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)\S*$/i

/**
 * Apply an action to the editor. Returns false when there is nothing to write
 * to — the caller is a `KeyBinding.run`, which reports "not handled" that way.
 */
export function runMarkdownAction(view: EditorView, action: MarkdownAction): boolean {
  if (view.state.readOnly) return false
  switch (action.kind) {
    case 'inline':
      toggleInline(view, action.mark)
      break
    case 'heading':
      toggleHeading(view, action.level)
      break
    case 'line':
      toggleLineMarker(view, action.marker)
      break
    case 'block': {
      const { from, to } = view.state.selection.main
      insertTemplate(view, blockTemplate(action.block, view.state.sliceDoc(from, to)))
      break
    }
    case 'table':
      insertTemplate(view, tableTemplate(action.spec))
      break
    case 'footnote':
      insertFootnote(view)
      break
    case 'link':
      insertLink(view, action.url)
      break
  }
  view.focus()
  return true
}

/**
 * Bold / italic / link, on the keys every editor uses for them.
 *
 * `stopPropagation` is what makes `Mod-k` work: the shortcut list is bound on
 * `window`, which sees the key after CodeMirror unless the binding stops it
 * there. The list stays reachable from every other tab, from F1, and from the
 * `?` button. `onLink` is a callback because the toolbar reads the clipboard
 * for a target first, which a `Command` cannot wait for.
 */
export function markdownAssistKeymap(onLink: () => void): KeyBinding[] {
  const inline = (mark: InlineMark): KeyBinding['run'] => {
    return (view) => runMarkdownAction(view, { kind: 'inline', mark })
  }
  return [
    { key: 'Mod-b', run: inline('**'), preventDefault: true, stopPropagation: true },
    { key: 'Mod-i', run: inline('*'), preventDefault: true, stopPropagation: true },
    {
      key: 'Mod-k',
      run: () => {
        onLink()
        return true
      },
      preventDefault: true,
      stopPropagation: true,
    },
  ]
}

/** How many `ch` a string ends with. */
function trailingRun(text: string, ch: string): number {
  let n = 0
  while (n < text.length && text[text.length - 1 - n] === ch) n++
  return n
}

/** How many `ch` a string starts with. */
function leadingRun(text: string, ch: string): number {
  let n = 0
  while (n < text.length && text[n] === ch) n++
  return n
}

/**
 * Is a run of `run` markers around the text already this mark?
 *
 * The asterisks are the reason this is not just `run >= len`. One is italic,
 * two are bold, three are both, so a run's length says which marks are on:
 * italic is there when the count is odd, bold whenever there are two or more.
 * Reading `**bold**` as "starts and ends with `*`" is what turned Ctrl+I on a
 * bold word into a silent downgrade to italic.
 */
function runHasMark(run: number, mark: InlineMark): boolean {
  if (mark === '*') return run % 2 === 1
  if (mark === '**') return run >= 2
  return run >= mark.length
}

/** Long enough to tell `*`, `**` and `***` apart; nothing needs more. */
const RUN_WINDOW = 4

/**
 * Wrap the selection in `mark`, or take the marks off when they are already
 * there — whether they sit inside the selection or just outside it, since
 * selecting the text of a bold span leaves the asterisks on either side.
 */
function toggleInline(view: EditorView, mark: InlineMark) {
  const len = mark.length
  const ch = mark[0]
  view.dispatch(
    view.state.changeByRange((range) => {
      const { from, to } = range
      const doc = view.state.doc
      const inner = doc.sliceString(from, to)
      if (
        inner.length >= len * 2 &&
        runHasMark(leadingRun(inner, ch), mark) &&
        runHasMark(trailingRun(inner, ch), mark)
      ) {
        return {
          changes: { from, to, insert: inner.slice(len, inner.length - len) },
          range: EditorSelection.range(from, to - len * 2),
        }
      }
      const before = doc.sliceString(Math.max(0, from - RUN_WINDOW), from)
      const after = doc.sliceString(to, Math.min(doc.length, to + RUN_WINDOW))
      if (runHasMark(trailingRun(before, ch), mark) && runHasMark(leadingRun(after, ch), mark)) {
        return {
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          range: EditorSelection.range(from - len, to - len),
        }
      }
      return {
        changes: [
          { from, insert: mark },
          { from: to, insert: mark },
        ],
        range: EditorSelection.range(from + len, to + len),
      }
    }),
  )
}

/** Every line the selection touches, in document order and without repeats. */
function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    let pos = range.from
    for (;;) {
      const line = state.doc.lineAt(pos)
      // Shift+Down from a line's start selects up to the *start* of the next
      // line without reaching into it. A line command must not mark that line.
      if (line.from === range.to && range.to > range.from) break
      if (!seen.has(line.from)) {
        seen.add(line.from)
        lines.push(line)
      }
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  // No sort: CodeMirror keeps `selection.ranges` in document order and each
  // range is walked forwards. The Set is for two cursors landing on one line.
  return lines
}

/** Replace a line's prefix, skipping the write when it already reads that way. */
function replacePrefix(changes: ChangeSpec[], line: Line, length: number, insert: string) {
  if (line.text.slice(0, length) === insert) return
  changes.push({ from: line.from, to: line.from + length, insert })
}

function indentOf(text: string): string {
  return INDENT_RE.exec(text)?.[0] ?? ''
}

function apply(view: EditorView, changes: ChangeSpec[]) {
  if (changes.length) view.dispatch({ changes })
}

/** Set every selected line to `level`, or back to a paragraph when it is already there. */
function toggleHeading(view: EditorView, level: number) {
  const changes: ChangeSpec[] = []
  for (const line of selectedLines(view.state)) {
    const m = HEADING_RE.exec(line.text)
    const indent = m ? m[1] : indentOf(line.text)
    const target = m && m[2].length === level ? 0 : level
    const eaten = m ? m[0].length : indent.length
    replacePrefix(changes, line, eaten, target ? `${indent}${'#'.repeat(target)} ` : indent)
  }
  apply(view, changes)
}

/** Which marker a line already carries, if any. */
function markerOf(text: string): LineMarker | null {
  if (QUOTE_RE.test(text)) return 'quote'
  const m = LIST_RE.exec(text)
  if (!m) return null
  if (m[3]) return 'task'
  return /\d/.test(m[2]) ? 'ordered' : 'bullet'
}

/** What each marker writes after the line's indent. `n` is the item's position. */
const MARKER_PREFIX: Record<LineMarker, (n: number) => string> = {
  quote: () => '> ',
  bullet: () => '- ',
  task: () => '- [ ] ',
  ordered: (n) => `${n}. `,
}

/**
 * Put `marker` on every selected line, or take it off when they all already
 * have it — one verdict for the whole selection, so a button press does not
 * mark half the lines and unmark the other half.
 *
 * A quote is independent of the list markers (a quoted list is a real thing),
 * so it toggles on its own; the three list kinds replace each other.
 */
function toggleLineMarker(view: EditorView, marker: LineMarker) {
  const lines = selectedLines(view.state)
  // A blank line picked up by a multi-line selection is a paragraph break, not
  // an item waiting for a bullet — unless blank is all there is, in which case
  // the selection is where a list is about to be written and dropping every
  // line would make the button do nothing at all.
  const kept = lines.filter((l) => l.text.trim() !== '')
  const targets = lines.length > 1 && kept.length > 0 ? kept : lines
  const target = targets.every((l) => markerOf(l.text) === marker) ? null : marker
  const changes: ChangeSpec[] = []
  for (const [i, line] of targets.entries()) {
    const m = (marker === 'quote' ? QUOTE_RE : LIST_RE).exec(line.text)
    const indent = m ? m[1] : indentOf(line.text)
    // Numbering runs 1..n across the selection; a lazy `1.` on every line would
    // also render, but it reads as a mistake in the source.
    const prefix = target ? indent + MARKER_PREFIX[target](i + 1) : indent
    replacePrefix(changes, line, m ? m[0].length : indent.length, prefix)
  }
  apply(view, changes)
}

/** The fixed templates. Their caret positions are described with each one. */
function blockTemplate(block: BlockKind, selected: string): Template {
  switch (block) {
    case 'code': {
      // The caret goes on the info string: the fence is written, the language
      // is the part only the author knows.
      const text = `\`\`\`\n${selected}\n\`\`\``
      return { text, select: [3, 3] }
    }
    case 'hr':
      return { text: '---', select: [3, 3] }
    case 'details': {
      const summary = t('markdown.tplSummary')
      const body = selected || t('markdown.tplDetailsBody')
      const text = `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
      const at = '<details>\n<summary>'.length
      return { text, select: [at, at + summary.length] }
    }
  }
}

/** A GFM row: cells padded so the source is readable while it is being filled. */
function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/**
 * A table of the requested shape, always with a header.
 *
 * GFM has no headerless table: the delimiter row is what makes the block a
 * table at all, and it only ever follows a header. Leaving those cells empty
 * would render as a blank strip above the content, so the template fills them
 * in and starts the caret on the first one.
 */
function tableTemplate(spec: TableSpec): Template {
  const label = t('markdown.tplTableHeader')
  const cells = (fill: (i: number) => string) => Array.from({ length: spec.cols }, (_, i) => fill(i))
  const head = cells((i) => `${label} ${i + 1}`)
  const lines = [
    tableRow(head),
    tableRow(cells(() => '---')),
    ...Array.from({ length: spec.rows }, () => tableRow(cells(() => ''))),
  ]
  const at = '| '.length
  return { text: lines.join('\n'), select: [at, at + head[0].length] }
}

/** Drop a template in, on lines of its own, taking the selection into it. */
function insertTemplate(view: EditorView, { text, select }: Template) {
  const { state } = view
  const range = state.selection.main
  // A fence or a table has to start a line and end one, or the Markdown parser
  // folds it into the paragraph around it.
  const before = range.from > state.doc.lineAt(range.from).from ? '\n' : ''
  const after = range.to < state.doc.lineAt(range.to).to ? '\n' : ''
  const at = range.from + before.length
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: before + text + after },
    selection: EditorSelection.range(at + select[0], at + select[1]),
    scrollIntoView: true,
  })
}

/**
 * Reference at the cursor, definition at the end of the file, cursor on the
 * definition — the note itself is the part still to be written.
 */
function insertFootnote(view: EditorView) {
  const { state } = view
  const doc = state.doc.toString()
  let max = 0
  for (const m of doc.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]))
  const ref = `[^${max + 1}]`
  const def = `${doc.endsWith('\n') || doc.length === 0 ? '' : '\n'}\n${ref}: `
  const pos = state.selection.main.head
  view.dispatch({
    // Both offsets are in the current document; the definition is appended
    // last, so the reference insert shifts it by its own length.
    changes: [
      { from: pos, insert: ref },
      { from: doc.length, insert: def },
    ],
    selection: EditorSelection.cursor(doc.length + ref.length + def.length),
    scrollIntoView: true,
  })
}

/**
 * `[text](url)` around the selection. Which half is missing decides where the
 * cursor goes: a selected URL becomes the target and the caret waits for the
 * text, selected text becomes the text and the caret waits for the target.
 */
function insertLink(view: EditorView, url?: string) {
  const { state } = view
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to).trim()
  const selectedIsUrl = selected !== '' && URL_LIKE_RE.test(selected)
  const text = selectedIsUrl ? '' : selected
  const target = selectedIsUrl ? selected : (url ?? '')
  const insert = `[${text}](${target})`
  // Select a pre-filled target so it can be typed over; otherwise put the
  // cursor in whichever bracket is still empty.
  const select: [number, number] = text ? [text.length + 3, text.length + 3 + target.length] : [1, 1]
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(range.from + select[0], range.from + select[1]),
    scrollIntoView: true,
  })
}
