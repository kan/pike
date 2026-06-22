import { type Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

// Git conflict markers are exactly 7 characters, optionally followed by a label.
const START = /^<{7}(?:\s|$)/ // <<<<<<< ours
const BASE = /^\|{7}(?:\s|$)/ // ||||||| base (diff3 style)
const SEP = /^={7}(?:\s|$)/ //  ======= separator
const END = /^>{7}(?:\s|$)/ //  >>>>>>> theirs

const oursMarker = Decoration.line({ class: 'cm-conflict-ours-marker' })
const baseMarker = Decoration.line({ class: 'cm-conflict-base-marker' })
const sepMarker = Decoration.line({ class: 'cm-conflict-sep-marker' })
const theirsMarker = Decoration.line({ class: 'cm-conflict-theirs-marker' })
const oursLine = Decoration.line({ class: 'cm-conflict-ours' })
const baseLine = Decoration.line({ class: 'cm-conflict-base' })
const theirsLine = Decoration.line({ class: 'cm-conflict-theirs' })

type Section = 'none' | 'ours' | 'base' | 'theirs'

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  let section: Section = 'none'
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (START.test(text)) {
      builder.add(line.from, line.from, oursMarker)
      section = 'ours'
    } else if (section !== 'none' && BASE.test(text)) {
      builder.add(line.from, line.from, baseMarker)
      section = 'base'
    } else if (section !== 'none' && SEP.test(text)) {
      builder.add(line.from, line.from, sepMarker)
      section = 'theirs'
    } else if (section !== 'none' && END.test(text)) {
      builder.add(line.from, line.from, theirsMarker)
      section = 'none'
    } else if (section === 'ours') {
      builder.add(line.from, line.from, oursLine)
    } else if (section === 'base') {
      builder.add(line.from, line.from, baseLine)
    } else if (section === 'theirs') {
      builder.add(line.from, line.from, theirsLine)
    }
  }
  return builder.finish()
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
})

/**
 * Highlights git conflict regions (`<<<<<<<` / `=======` / `>>>>>>>`, plus the
 * diff3 `|||||||` base section) so they stand out in the editor. Read-only —
 * it does not provide resolution actions.
 */
export function conflictHighlight(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view)
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            this.decorations = buildDecorations(update.view)
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    conflictTheme,
  ]
}
