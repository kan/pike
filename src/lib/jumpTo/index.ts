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
import { fileTypeKey } from '../fileType'
import { extractOutline, type OutlineNode } from '../outline'
import { pathSep } from '../paths'
import { fsReadFile } from '../tauri'
import { escapeRegExp } from '../text'
import { findDefinitionInFile, wordAt } from './findInFile'
import { findImportAt, findImportForName, importedNameFor, parseImportsCached } from './parseImports'
import { findNearestUpward, resolveImport } from './resolveImport'
import { looksLikeCustomComponent, resolveVueComponent, tagNameAt } from './vueComponent'
import { xslateTemplateAt } from './xslateInclude'

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

export interface JumpRange {
  from: number
  to: number
}

/**
 * Sync, IPC-free pre-check used by hover decoration. Returns the range to
 * underline when something at `offset` *might* resolve — without doing any
 * filesystem work — or null. The actual click handler still runs
 * `jumpToDefinition` for the real lookup.
 *
 * **範囲は各分岐が自分で返す**（import のパス・Vue のタグ名・Xslate のテンプレート名・識別子）。
 * 呼び出し側が語の範囲を推し量ると、`foo::bar` や `@/foo` のように語の文字で切れる対象で
 * 下線がずれる。
 */
export function jumpableRangeAt(ctx: JumpContext): JumpRange | null {
  // 文書全体を文字列にする前に返す（Xslate は行だけを見る）。
  if (ctx.langId === 'tx') return xslateRefAt(ctx)

  const text = ctx.state.doc.toString()
  const imports = parseImportsCached(ctx.state.doc, text, ctx.langId)

  const imp = findImportAt(imports, ctx.offset)
  if (imp) return { from: imp.sourceFrom, to: imp.sourceTo }

  if (ctx.langId === 'vue') {
    const tag = tagNameAt(text, ctx.offset)
    if (tag && looksLikeCustomComponent(tag.name)) return tag
  }

  const word = wordAt(ctx.state, ctx.offset)
  if (!word) return null

  const local = findDefinitionInFile(word.text, ctx.state, ctx.langId)
  if (local && !(ctx.offset >= local.from && ctx.offset <= local.to)) return word

  return findImportForName(imports, word.text) ? word : null
}

export async function jumpToDefinition(ctx: JumpContext): Promise<JumpResult | null> {
  // Text::Xslate: `include` / `cascade` の引数 → テンプレートを開く（行だけを見るので先に返す）
  if (ctx.langId === 'tx') {
    const ref = xslateRefAt(ctx)
    if (!ref) return null
    const path = await findNearestUpward(ctx.filePath, ctx.projectRoot, pathSep(ctx.shell), ctx.shell, [ref.name])
    return path ? { target: { path } } : null
  }

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
 * Text::Xslate の `include` / `cascade` の対象。
 *
 * **テンプレートは Perl 側の設定（`path`）のディレクトリから引かれる**が、Pike はそれを読めない。
 * そのため解決は「開いているファイルから上へ辿り、`ディレクトリ + 名前` が実在する最初の場所」
 * にする（`findNearestUpward`）。テンプレートの木の中のファイル同士なら、木の根に着いた時点で
 * 見つかる。`path` に並べた別のディレクトリのテンプレートは開けない（見つからない表示になる）。
 */
function xslateRefAt(ctx: JumpContext) {
  const line = ctx.state.doc.lineAt(ctx.offset)
  const ref = xslateTemplateAt(line.text, ctx.offset - line.from)
  return ref && { name: ref.name, from: line.from + ref.from, to: line.from + ref.to }
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

/**
 * 別のファイルを開かずに宣言を探すときの種別（#347）。**共通の判定を通す**ので、
 * `Dockerfile.dev` のような複合名も他の 3 系統と同じキーになる。
 *
 * 以前は自前の正規表現で拡張子を取り、`mjs` / `cjs` を `js` に読み替えていた。分岐するのは
 * `go` と `vue` の 2 つだけなので、読み替えは要らない。
 */
function guessLangId(path: string): string {
  return fileTypeKey(path)
}

/**
 * Lightweight regex scan for a top-level declaration of `name` in `text`.
 * Used as a fallback when we don't have an EditorState for the target file.
 * Returns 1-based line, or null. Walks through plausible declaration shapes
 * and picks the first hit.
 */
function scanForDeclaration(text: string, name: string, langId: string): number | null {
  const escaped = escapeRegExp(name)
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
