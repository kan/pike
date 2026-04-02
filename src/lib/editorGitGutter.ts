import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { GitDiffLines } from './tauri'

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
}

function buildDiffData(diff: GitDiffLines): DiffData {
  const added = new Set<number>()
  const modified = new Set<number>()
  const deleted = new Set<number>()
  for (const [start, end] of diff.added) {
    for (let i = start; i <= end; i++) added.add(i)
  }
  for (const [start, end] of diff.modified) {
    for (let i = start; i <= end; i++) modified.add(i)
  }
  for (const line of diff.deleted) deleted.add(line)
  return { added, modified, deleted }
}

// Exported so minimap can read the same field without duplicating state
export const diffField = StateField.define<DiffData>({
  create() {
    return { added: new Set(), modified: new Set(), deleted: new Set() }
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
        const diff = buildDiffData(effect.value)
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

const gitGutter = gutter({
  class: 'cm-git-gutter',
  markers(view) {
    return view.state.field(gutterMarkers)
  },
})

const gitGutterTheme = EditorView.baseTheme({
  '.cm-git-gutter': { width: '3px', minWidth: '3px' },
  '.cm-git-gutter .cm-gutterElement': { padding: '0' },
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
})

export function gitDiffGutter() {
  return [diffField, gutterMarkers, gitGutter, gitGutterTheme]
}
