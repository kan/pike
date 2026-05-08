/**
 * Same-file symbol definition lookup using Lezer syntax trees.
 * Mirrors the patterns used by the outline extractors.
 *
 * Limitations: no scope analysis. We match by name across the whole file.
 * If the same name is declared multiple times (e.g. shadowing in nested
 * scopes), we return the first declaration we encounter.
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

export interface DefinitionHit {
  /** Offset of the name token in the document. */
  from: number
  to: number
  /** 1-based line number for jump UI. */
  line: number
  /** Lezer node name for diagnostics. */
  kind: string
}

/**
 * Find a definition matching `name` in the current document. `langId` is used
 * to gate which declaration kinds we recognize (Vue / JS / TS share most of
 * the same patterns; Go has its own set).
 */
export function findDefinitionInFile(name: string, state: EditorState, langId: string): DefinitionHit | null {
  if (!name) return null
  const tree = syntaxTree(state)
  const text = state.doc.toString()

  if (langId === 'go') {
    return findGoDef(tree.topNode, text, state, name)
  }
  return findJsDef(tree.topNode, text, state, name)
}

// ---- TS / JS / Vue ----

const JS_DECL_NODES = new Set<string>([
  'FunctionDeclaration',
  'ClassDeclaration',
  'InterfaceDeclaration',
  'TypeAliasDeclaration',
  'EnumDeclaration',
  'VariableDeclaration',
  'MethodDeclaration',
  'PropertyDeclaration',
])

function findJsDef(top: SyntaxNode, text: string, state: EditorState, name: string): DefinitionHit | null {
  let result: DefinitionHit | null = null
  const cur = top.cursor()
  do {
    if (result) break
    if (!JS_DECL_NODES.has(cur.name)) continue
    const node = cur.node
    const hit = jsDeclName(node, text)
    if (hit && hit.text === name) {
      result = {
        from: hit.from,
        to: hit.to,
        line: state.doc.lineAt(hit.from).number,
        kind: cur.name,
      }
      break
    }
    // VariableDeclaration may bind multiple names: `const a = 1, b = 2`
    if (cur.name === 'VariableDeclaration') {
      for (const def of variableDefs(node, text)) {
        if (def.text === name) {
          result = {
            from: def.from,
            to: def.to,
            line: state.doc.lineAt(def.from).number,
            kind: cur.name,
          }
          break
        }
      }
    }
  } while (cur.next())
  return result
}

function jsDeclName(node: SyntaxNode, text: string): { text: string; from: number; to: number } | null {
  // FunctionDeclaration / ClassDeclaration → VariableDefinition child
  // InterfaceDeclaration / TypeAliasDeclaration / EnumDeclaration → TypeDefinition child
  // MethodDeclaration / PropertyDeclaration → PropertyDefinition or PropertyName
  const candidates = ['VariableDefinition', 'TypeDefinition', 'PropertyDefinition', 'PropertyName']
  let c = node.firstChild
  while (c) {
    if (candidates.includes(c.name)) {
      return { text: text.slice(c.from, c.to), from: c.from, to: c.to }
    }
    c = c.nextSibling
  }
  return null
}

function variableDefs(node: SyntaxNode, text: string): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = []
  const cur = node.cursor()
  do {
    if (cur.name === 'VariableDefinition' && cur.node.parent === node) {
      out.push({ text: text.slice(cur.from, cur.to), from: cur.from, to: cur.to })
    }
  } while (cur.next() && cur.from < node.to)
  return out
}

// ---- Go ----

function findGoDef(top: SyntaxNode, text: string, state: EditorState, name: string): DefinitionHit | null {
  let result: DefinitionHit | null = null
  const cur = top.cursor()
  do {
    if (result) break
    const kind = cur.name
    if (kind === 'FunctionDeclaration' || kind === 'MethodDeclaration') {
      const ident = findIdentChild(cur.node, ['Identifier', 'FieldIdentifier'])
      if (ident && text.slice(ident.from, ident.to) === name) {
        result = {
          from: ident.from,
          to: ident.to,
          line: state.doc.lineAt(ident.from).number,
          kind,
        }
        break
      }
    }
    if (kind === 'TypeSpec' || kind === 'ConstSpec' || kind === 'VarSpec') {
      // First identifier child is the declared name (or first of the comma-list)
      let c = cur.node.firstChild
      while (c) {
        if (c.name === 'Identifier' && text.slice(c.from, c.to) === name) {
          result = {
            from: c.from,
            to: c.to,
            line: state.doc.lineAt(c.from).number,
            kind,
          }
          break
        }
        c = c.nextSibling
      }
      if (result) break
    }
  } while (cur.next())
  return result
}

function findIdentChild(node: SyntaxNode, kinds: string[]): SyntaxNode | null {
  let c = node.firstChild
  while (c) {
    if (kinds.includes(c.name)) return c
    c = c.nextSibling
  }
  return null
}

/**
 * Get the identifier-like text at `offset` (or the cursor) using the doc.
 * Returns the word matching /[A-Za-z_$][A-Za-z0-9_$]* / spanning that offset.
 */
export function wordAt(state: EditorState, offset: number): { text: string; from: number; to: number } | null {
  const line = state.doc.lineAt(offset)
  const lineText = line.text
  const col = offset - line.from
  // Find word boundaries
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch)
  let start = col
  while (start > 0 && isWord(lineText[start - 1])) start--
  let end = col
  while (end < lineText.length && isWord(lineText[end])) end++
  if (start === end) return null
  const text = lineText.slice(start, end)
  if (!/^[A-Za-z_$]/.test(text)) return null
  return { text, from: line.from + start, to: line.from + end }
}
