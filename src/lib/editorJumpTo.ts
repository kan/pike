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
import { type JumpTarget, jumpToDefinition } from './jumpTo'

export interface JumpToContext {
  filePath: string
  projectRoot: string
  shell: ShellType
  langId: string
}

export interface JumpToOptions {
  /** Returns null when context isn't ready (e.g. before file is loaded). */
  getContext: () => JumpToContext | null
  onJump: (target: JumpTarget) => void
  /** Called when multiple candidates are found. */
  onPickCandidate?: (candidates: JumpTarget[]) => void
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
        // Don't preventDefault yet — let CM place the caret first, then we
        // run the lookup async.
        event.preventDefault()
        runJump(view, offset, ctx, opts)
        return true
      },
      mousemove(event, view) {
        if (!isModKey(event)) {
          if (hasHover(view)) view.dispatch({ effects: setHoverRange.of(null) })
          return false
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (offset == null) {
          view.dispatch({ effects: setHoverRange.of(null) })
          return false
        }
        const ctx = opts.getContext()
        if (!ctx) return false
        scheduleHover(view, offset, ctx)
        return false
      },
      mouseleave(_event, view) {
        view.dispatch({ effects: setHoverRange.of(null) })
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
        if (event.key === 'Control' || event.key === 'Meta') {
          // Force-refresh hover decoration on next mousemove
          return false
        }
        return false
      },
      keyup(event, view) {
        if (event.key === 'Control' || event.key === 'Meta') {
          if (hasHover(view)) view.dispatch({ effects: setHoverRange.of(null) })
        }
        return false
      },
    }),
    // Clear hover when scrolling so stale decorations don't linger
    ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          if (update.geometryChanged && hasHover(update.view)) {
            update.view.dispatch({ effects: setHoverRange.of(null) })
          }
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

let hoverToken = 0

function scheduleHover(view: EditorView, offset: number, ctx: JumpToContext): void {
  const myToken = ++hoverToken
  // Run the lookup off the event handler. We don't need a debounce because
  // jumpToDefinition is fast (regex + Lezer + maybe one fs probe).
  ;(async () => {
    try {
      const res = await jumpToDefinition({
        state: view.state,
        offset,
        filePath: ctx.filePath,
        projectRoot: ctx.projectRoot,
        shell: ctx.shell,
        langId: ctx.langId,
      })
      if (myToken !== hoverToken) return
      if (!res?.target && !res?.candidates?.length) {
        view.dispatch({ effects: setHoverRange.of(null) })
        return
      }
      const range = wordRangeAt(view, offset)
      if (range) view.dispatch({ effects: setHoverRange.of(range) })
    } catch {
      /* swallow — hover is best-effort */
    }
  })()
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
  try {
    const res = await jumpToDefinition({
      state: view.state,
      offset,
      filePath: ctx.filePath,
      projectRoot: ctx.projectRoot,
      shell: ctx.shell,
      langId: ctx.langId,
    })
    view.dispatch({ effects: setHoverRange.of(null) })
    if (!res) return
    if (res.target) {
      opts.onJump(res.target)
      return
    }
    if (res.candidates && res.candidates.length > 0) {
      if (res.candidates.length === 1) {
        opts.onJump(res.candidates[0])
      } else if (opts.onPickCandidate) {
        opts.onPickCandidate(res.candidates)
      } else {
        opts.onJump(res.candidates[0])
      }
    }
  } catch {
    /* swallow — no-op when jump fails */
  }
}
