import type { Text } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, hoverTooltip } from '@codemirror/view'
import type { DiagnosticSeverity } from '../types/diagnostics'

/** A diagnostic in doc-independent (line/column) form, as the store holds it. */
export interface EditorDiagnostic {
  /** 1-based. */
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: DiagnosticSeverity
  message: string
  source: string
  code?: string
}

/** Replace the diagnostics shown in the editor. */
export const setDiagnostics = StateEffect.define<EditorDiagnostic[]>()

interface RangedDiag {
  from: number
  to: number
  diag: EditorDiagnostic
}

/** Extend `from` to the end of the word at that offset, for diagnostics that
 *  carry no end position (go vet / tsc). Falls back to a single char. */
function wordEnd(line: string, lineFrom: number, from: number, lineTo: number): number {
  let i = from - lineFrom
  const isWord = (c: string) => /[\w$]/.test(c)
  if (i < line.length && isWord(line[i])) {
    while (i < line.length && isWord(line[i])) i++
    return lineFrom + i
  }
  return Math.min(from + 1, lineTo)
}

function rangeFor(doc: Text, d: EditorDiagnostic): RangedDiag | null {
  if (d.line < 1 || d.line > doc.lines) return null
  const line = doc.line(d.line)
  const from = Math.min(line.from + Math.max(0, d.column - 1), line.to)
  let to: number
  if (d.endLine && d.endColumn && (d.endLine > d.line || d.endColumn > d.column)) {
    if (d.endLine > doc.lines) {
      to = doc.line(doc.lines).to
    } else {
      const el = doc.line(d.endLine)
      to = Math.min(el.from + Math.max(0, d.endColumn - 1), el.to)
    }
  } else {
    to = wordEnd(line.text, line.from, from, line.to)
  }
  if (to <= from) return null // empty line — nothing to underline
  return { from, to, diag: d }
}

function computeRanges(doc: Text, diags: EditorDiagnostic[]): RangedDiag[] {
  const out: RangedDiag[] = []
  for (const d of diags) {
    const r = rangeFor(doc, d)
    if (r) out.push(r)
  }
  return out
}

const diagRangeField = StateField.define<RangedDiag[]>({
  create() {
    return []
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiagnostics)) {
        return computeRanges(tr.state.doc, e.value)
      }
    }
    // Keep squiggles roughly aligned while the user edits between checks.
    if (tr.docChanged && value.length) {
      const mapped: RangedDiag[] = []
      for (const r of value) {
        const from = tr.changes.mapPos(r.from, 1)
        const to = tr.changes.mapPos(r.to, -1)
        if (to > from) mapped.push({ from, to, diag: r.diag })
      }
      return mapped
    }
    return value
  },
})

function severityClass(s: DiagnosticSeverity): string {
  return s === 'error' ? 'cm-diag-error' : 'cm-diag-warning'
}

function severityIcon(s: DiagnosticSeverity): string {
  return s === 'error' ? '●' : '▲'
}

const diagDecorations = EditorView.decorations.compute([diagRangeField], (state): DecorationSet => {
  const ranges = state.field(diagRangeField)
  if (!ranges.length) return Decoration.none
  const marks = ranges
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((r) => Decoration.mark({ class: severityClass(r.diag.severity) }).range(r.from, r.to))
  return Decoration.set(marks, true)
})

const diagHover = hoverTooltip((view, pos) => {
  const ranges = view.state.field(diagRangeField).filter((r) => pos >= r.from && pos <= r.to)
  if (!ranges.length) return null
  return {
    pos: Math.min(...ranges.map((r) => r.from)),
    end: Math.max(...ranges.map((r) => r.to)),
    above: true,
    create() {
      const dom = document.createElement('div')
      dom.className = 'cm-diag-tooltip'
      for (const r of ranges) {
        const row = document.createElement('div')
        row.className = 'cm-diag-tooltip-row'
        const sev = document.createElement('span')
        sev.className = r.diag.severity === 'error' ? 'cm-diag-tip-error' : 'cm-diag-tip-warning'
        sev.textContent = severityIcon(r.diag.severity)
        row.appendChild(sev)
        const msg = document.createElement('span')
        const tag = r.diag.code ? `${r.diag.source} ${r.diag.code}` : r.diag.source
        msg.textContent = `${r.diag.message} (${tag})`
        row.appendChild(msg)
        dom.appendChild(row)
      }
      return { dom }
    },
  }
})

const diagTheme = EditorView.baseTheme({
  '.cm-diag-error': { textDecoration: 'underline wavy #f85149', textDecorationSkipInk: 'none' },
  '.cm-diag-warning': { textDecoration: 'underline wavy #d29922', textDecorationSkipInk: 'none' },
  '.cm-diag-tooltip': {
    padding: '4px 8px',
    maxWidth: '480px',
    fontSize: '12px',
    lineHeight: '1.45',
    whiteSpace: 'normal',
  },
  '.cm-diag-tooltip-row': { display: 'flex', gap: '6px', alignItems: 'baseline' },
  '.cm-diag-tip-error': { color: '#f85149' },
  '.cm-diag-tip-warning': { color: '#d29922' },
})

export function diagnosticsExtension() {
  return [diagRangeField, diagDecorations, diagHover, diagTheme]
}
