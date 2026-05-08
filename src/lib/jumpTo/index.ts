/**
 * Public entry point for editor "go to definition".
 *
 * Phase 1 + Phase 2 scope:
 *  - Click on import path → open resolved file
 *  - Click on Vue tag (`<MyComponent>`) → open imported file
 *  - Click on identifier → same-file decl, then cross-file via import +
 *    target-file outline
 *
 * Returns either a single jump target (immediate jump) or a list of
 * candidates (caller shows a picker).
 */

import type { EditorState } from '@codemirror/state'
import type { ShellType } from '../../types/tab'
import { extractOutline, type OutlineNode } from '../outline'
import { fsReadFile } from '../tauri'
import { findDefinitionInFile, wordAt } from './findInFile'
import { findImportAt, findImportForName, importedNameFor, parseImportsCached } from './parseImports'
import { resolveImport } from './resolveImport'
import { looksLikeCustomComponent, resolveVueComponent, tagNameAt } from './vueComponent'

export interface JumpTarget {
  path: string
  line?: number
}

export interface JumpResult {
  /** When exactly one target — caller jumps immediately. */
  target?: JumpTarget
  /** When multiple — caller shows a picker. */
  candidates?: JumpTarget[]
}

export interface JumpContext {
  state: EditorState
  offset: number
  filePath: string
  projectRoot: string
  shell: ShellType
  langId: string
}

/**
 * Sync, IPC-free pre-check used by hover decoration. Returns true when
 * something at `offset` *might* resolve — without doing any filesystem work.
 * The actual click handler still runs `jumpToDefinition` for the real lookup.
 */
export function isJumpableAt(ctx: JumpContext): boolean {
  const text = ctx.state.doc.toString()
  const imports = parseImportsCached(ctx.state.doc, text, ctx.langId)

  if (findImportAt(imports, ctx.offset)) return true

  if (ctx.langId === 'vue') {
    const tag = tagNameAt(text, ctx.offset)
    if (tag && looksLikeCustomComponent(tag.name)) return true
  }

  const word = wordAt(ctx.state, ctx.offset)
  if (!word) return false

  const local = findDefinitionInFile(word.text, ctx.state, ctx.langId)
  if (local && !(ctx.offset >= local.from && ctx.offset <= local.to)) return true

  return findImportForName(imports, word.text) !== null
}

export async function jumpToDefinition(ctx: JumpContext): Promise<JumpResult | null> {
  const text = ctx.state.doc.toString()

  // 1. Click on an import path string → open file
  const imports = parseImportsCached(ctx.state.doc, text, ctx.langId)
  const onImport = findImportAt(imports, ctx.offset)
  if (onImport) {
    const resolved = await resolveImport({
      importPath: onImport.source,
      fromFile: ctx.filePath,
      projectRoot: ctx.projectRoot,
      shell: ctx.shell,
      langId: ctx.langId,
    })
    if (resolved) return { target: { path: resolved } }
    return null
  }

  // 2. Vue: click on `<MyComponent` opening tag → resolve via imports
  if (ctx.langId === 'vue') {
    const tag = tagNameAt(text, ctx.offset)
    if (tag && looksLikeCustomComponent(tag.name)) {
      const resolved = await resolveVueComponent({
        componentName: tag.name,
        sfcText: text,
        fromFile: ctx.filePath,
        projectRoot: ctx.projectRoot,
        shell: ctx.shell,
        imports,
      })
      if (resolved) return { target: { path: resolved } }
      return null
    }
  }

  // 3. Identifier: same file → cross-file via imports
  const word = wordAt(ctx.state, ctx.offset)
  if (!word) return null

  // 3a. Same-file declaration
  const local = findDefinitionInFile(word.text, ctx.state, ctx.langId)
  if (local) {
    // Avoid trivial self-jump if the click is on the declaration itself
    if (!(ctx.offset >= local.from && ctx.offset <= local.to)) {
      return { target: { path: ctx.filePath, line: local.line } }
    }
  }

  // 3b. Cross-file via import binding
  const imp = findImportForName(imports, word.text)
  if (imp) {
    const resolved = await resolveImport({
      importPath: imp.source,
      fromFile: ctx.filePath,
      projectRoot: ctx.projectRoot,
      shell: ctx.shell,
      langId: ctx.langId,
    })
    if (resolved) {
      const exported = importedNameFor(imp, word.text)
      const line = exported && exported !== 'default' ? await findLineInFile(resolved, exported, ctx.shell) : undefined
      return { target: { path: resolved, line: line ?? undefined } }
    }
  }

  return null
}

/**
 * Read `path` and locate `name` in its outline. Returns the 1-based line
 * number, or undefined when not found / unsupported language.
 */
async function findLineInFile(path: string, name: string, shell: ShellType): Promise<number | undefined> {
  let text: string
  try {
    const result = await fsReadFile(shell, path)
    text = result.content
  } catch {
    return undefined
  }
  const langId = guessLangId(path)
  // Build a minimal EditorState-like context for extractOutline. We don't
  // want to instantiate a real EditorState here (that requires loading
  // language packs). Fall back to a regex-based scan.
  const line = scanForDeclaration(text, name, langId)
  return line ?? undefined
}

function guessLangId(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  if (!m) return ''
  const ext = m[1].toLowerCase()
  if (ext === 'mjs' || ext === 'cjs') return 'js'
  return ext
}

/**
 * Lightweight regex scan for a top-level declaration of `name` in `text`.
 * Used as a fallback when we don't have an EditorState for the target file.
 * Returns 1-based line, or null. Walks through plausible declaration shapes
 * and picks the first hit.
 */
function scanForDeclaration(text: string, name: string, langId: string): number | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let patterns: RegExp[]
  if (langId === 'go') {
    patterns = [
      new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s+)?${escaped}\\b`, 'm'),
      new RegExp(`^\\s*type\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*(?:var|const)\\s+${escaped}\\b`, 'm'),
    ]
  } else {
    patterns = [
      new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*export\\s+(?:default\\s+)?class\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*export\\s+(?:const|let|var)\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*export\\s+(?:type|interface|enum)\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*(?:async\\s+)?function\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*class\\s+${escaped}\\b`, 'm'),
      new RegExp(`^\\s*(?:const|let|var)\\s+${escaped}\\b`, 'm'),
    ]
  }
  for (const re of patterns) {
    const m = re.exec(text)
    if (m && m.index !== undefined) {
      // Convert offset → line number
      let line = 1
      for (let i = 0; i < m.index; i++) {
        if (text.charCodeAt(i) === 10) line++
      }
      return line
    }
  }
  return null
}

// Re-export the outline helper signature for convenience (used in tests)
export type { OutlineNode }
export { extractOutline }
