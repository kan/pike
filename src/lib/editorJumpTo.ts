/**
 * CodeMirror 6 extension for "go to definition".
 *
 * Activation:
 *  - Ctrl+click on a target → jump
 *  - F12 with cursor on a target → jump
 *  - Ctrl+hover → underline + pointer cursor
 *
 * The extension is config-only; the actual lookup runs in `lib/jumpTo`.
 */

import { type Extension, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { ShellType } from '../types/tab'
import { isJumpableAt, type JumpTarget, jumpToDefinition } from './jumpTo'

export interface JumpToContext {
  filePath: string
  projectRoot: string
  shell: ShellType
  langId: string
}

export type JumpStatus = { kind: 'searching' } | { kind: 'opened'; target: JumpTarget } | { kind: 'not-found' }

export interface JumpToOptions {
  /** Returns null when context isn't ready (e.g. before file is loaded). */
  getContext: () => JumpToContext | null
  onJump: (target: JumpTarget) => void
  /** Called when multiple candidates are found. */
  onPickCandidate?: (candidates: JumpTarget[]) => void
  /** Progress / outcome reporting for the StatusBar. */
  onStatus?: (status: JumpStatus) => void
}

const setHoverRange = StateEffect.define<{ from: number; to: number } | null>()

const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setHoverRange)) {
        deco = e.value
          ? Decoration.set([
              Decoration.mark({
                class: 'cm-jumpto-hover',
                attributes: { style: 'cursor: pointer' },
              }).range(e.value.from, e.value.to),
            ])
          : Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const hoverTheme = EditorView.theme({
  '.cm-jumpto-hover': {
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    textDecorationColor: 'var(--accent, #5865f2)',
  },
})

export function jumpToDefinitionExtension(opts: JumpToOptions): Extension {
  return [
    hoverField,
    hoverTheme,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!isModKey(event)) return false
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (offset == null) return false
        const ctx = opts.getContext()
        if (!ctx) return false
        event.preventDefault()
        runJump(view, offset, ctx, opts)
        return true
      },
      mousemove(event, view) {
        if (!isModKey(event)) {
          clearHover(view)
          return false
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (offset == null) {
          clearHover(view)
          return false
        }
        const ctx = opts.getContext()
        if (!ctx) return false
        scheduleHover(view, offset, ctx)
        return false
      },
      mouseleave(_event, view) {
        clearHover(view)
        return false
      },
      keydown(event, view) {
        if (event.key === 'F12' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const offset = view.state.selection.main.head
          const ctx = opts.getContext()
          if (!ctx) return false
          event.preventDefault()
          runJump(view, offset, ctx, opts)
          return true
        }
        return false
      },
      keyup(event, view) {
        if (event.key === 'Control' || event.key === 'Meta') {
          clearHover(view)
        }
        return false
      },
    }),
    // Clear hover when scrolling so stale decorations don't linger
    ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          if (update.geometryChanged) clearHover(update.view)
        }
      },
    ),
  ]
}

function isModKey(event: MouseEvent): boolean {
  // Ctrl on Win/Linux, Cmd on macOS — matches VS Code's go-to-def gesture
  return event.ctrlKey || event.metaKey
}

function hasHover(view: EditorView): boolean {
  return view.state.field(hoverField).size > 0
}

function clearHover(view: EditorView): void {
  if (hasHover(view)) view.dispatch({ effects: setHoverRange.of(null) })
}

function scheduleHover(view: EditorView, offset: number, ctx: JumpToContext): void {
  // Hover uses the sync IPC-free pre-check — running the full async resolver
  // (which may read tsconfig / vite.config from disk) on every mousemove is
  // too expensive. The actual click handler still runs the full resolver.
  const jumpable = isJumpableAt({
    state: view.state,
    offset,
    filePath: ctx.filePath,
    projectRoot: ctx.projectRoot,
    shell: ctx.shell,
    langId: ctx.langId,
  })
  if (!jumpable) {
    clearHover(view)
    return
  }
  const range = wordRangeAt(view, offset)
  if (!range) {
    clearHover(view)
    return
  }
  // Skip dispatch when the same range is already highlighted.
  const cur = view.state.field(hoverField)
  let same = false
  cur.between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) same = true
    return false
  })
  if (!same) view.dispatch({ effects: setHoverRange.of(range) })
}

function wordRangeAt(view: EditorView, offset: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(offset)
  const col = offset - line.from
  const text = line.text
  const isWord = (ch: string) => /[A-Za-z0-9_$\-./]/.test(ch)
  let s = col
  while (s > 0 && isWord(text[s - 1])) s--
  let e = col
  while (e < text.length && isWord(text[e])) e++
  if (s === e) return null
  return { from: line.from + s, to: line.from + e }
}

async function runJump(view: EditorView, offset: number, ctx: JumpToContext, opts: JumpToOptions): Promise<void> {
  opts.onStatus?.({ kind: 'searching' })
  try {
    const res = await jumpToDefinition({
      state: view.state,
      offset,
      filePath: ctx.filePath,
      projectRoot: ctx.projectRoot,
      shell: ctx.shell,
      langId: ctx.langId,
    })
    clearHover(view)

    const target = pickTarget(res)
    if (target) {
      opts.onJump(target)
      opts.onStatus?.({ kind: 'opened', target })
      return
    }
    if (res?.candidates && res.candidates.length > 1 && opts.onPickCandidate) {
      opts.onPickCandidate(res.candidates)
      // Picker takes over from here; don't emit a status.
      return
    }
    opts.onStatus?.({ kind: 'not-found' })
  } catch {
    opts.onStatus?.({ kind: 'not-found' })
  }
}

function pickTarget(res: { target?: JumpTarget; candidates?: JumpTarget[] } | null): JumpTarget | null {
  if (!res) return null
  if (res.target) return res.target
  if (res.candidates && res.candidates.length === 1) return res.candidates[0]
  return null
}
