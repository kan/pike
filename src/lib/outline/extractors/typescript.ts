import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

/**
 * Walk a Lezer JS/TS subtree and produce outline nodes for its top-level decls.
 * Exposed so other extractors (e.g. Vue SFC) can re-use this logic by parsing
 * an inner script block themselves and feeding the resulting `topNode`.
 */
export function walkJsChildren(
  parent: SyntaxNode,
  text: string,
  lineFor: (offset: number) => number,
  inClass = false,
): OutlineNode[] {
  return walkChildren(parent, text, lineFor, inClass)
}

/**
 * Inner walker that produces outline nodes for the children of `parent`.
 * `inClass` enables MethodDeclaration / PropertyDeclaration detection.
 */
function walkChildren(
  parent: SyntaxNode,
  text: string,
  lineFor: (offset: number) => number,
  inClass = false,
): OutlineNode[] {
  const out: OutlineNode[] = []
  let cur = parent.firstChild
  while (cur) {
    const nodes = handle(cur, text, lineFor, inClass)
    for (const n of nodes) out.push(n)
    cur = cur.nextSibling
  }
  return out
}

function handle(node: SyntaxNode, text: string, lineFor: (offset: number) => number, inClass: boolean): OutlineNode[] {
  switch (node.name) {
    case 'ExportDeclaration': {
      // Surface any wrapped declarations.
      let c = node.firstChild
      const out: OutlineNode[] = []
      while (c) {
        for (const n of handle(c, text, lineFor, inClass)) out.push(n)
        c = c.nextSibling
      }
      return out
    }
    case 'FunctionDeclaration': {
      const name = childText(node, 'VariableDefinition', text) ?? '(anonymous)'
      const block = findChild(node, 'Block')
      const inner = block ? walkChildren(block, text, lineFor, false) : []
      return [makeNode('function', name, node, lineFor, inner)]
    }
    case 'ClassDeclaration': {
      const name = childText(node, 'VariableDefinition', text) ?? '(anonymous)'
      const body = findChild(node, 'ClassBody')
      const members = body ? walkChildren(body, text, lineFor, true) : []
      return [makeNode('class', name, node, lineFor, members)]
    }
    case 'InterfaceDeclaration': {
      const name = childText(node, 'TypeDefinition', text) ?? '(anonymous)'
      return [makeNode('interface', name, node, lineFor, [])]
    }
    case 'TypeAliasDeclaration': {
      const name = childText(node, 'TypeDefinition', text) ?? '(anonymous)'
      return [makeNode('type', name, node, lineFor, [])]
    }
    case 'EnumDeclaration': {
      const name = childText(node, 'TypeDefinition', text) ?? '(anonymous)'
      const body = findChild(node, 'EnumBody')
      const members: OutlineNode[] = []
      if (body) {
        let c = body.firstChild
        while (c) {
          if (c.name === 'PropertyName') {
            members.push(makeNode('enumMember', text.slice(c.from, c.to), c, lineFor, []))
          }
          c = c.nextSibling
        }
      }
      return [makeNode('enum', name, node, lineFor, members)]
    }
    case 'NamespaceDeclaration': {
      const name = childText(node, 'VariableDefinition', text) ?? '(anonymous)'
      const block = findChild(node, 'Block')
      const inner = block ? walkChildren(block, text, lineFor, false) : []
      return [makeNode('namespace', name, node, lineFor, inner)]
    }
    case 'VariableDeclaration': {
      return makeFromVarDecl(node, text, lineFor)
    }
    case 'MethodDeclaration': {
      if (!inClass) return []
      const name =
        childText(node, 'PropertyDefinition', text) ??
        childText(node, 'PrivatePropertyDefinition', text) ??
        '(anonymous)'
      const kind: OutlineKind = name === 'constructor' ? 'constructor' : 'method'
      const block = findChild(node, 'Block')
      const inner = block ? walkChildren(block, text, lineFor, false) : []
      return [makeNode(kind, name, node, lineFor, inner)]
    }
    case 'PropertyDeclaration': {
      if (!inClass) return []
      const name =
        childText(node, 'PropertyDefinition', text) ??
        childText(node, 'PrivatePropertyDefinition', text) ??
        '(anonymous)'
      return [makeNode('property', name, node, lineFor, [])]
    }
    default:
      return []
  }
}

const VAR_INITIALIZER_TYPES = new Set([
  'ArrowFunction',
  'FunctionExpression',
  'ClassExpression',
  'ObjectExpression',
  'CallExpression',
])

/**
 * Many framework patterns wrap a callback: `defineStore('x', () => {...})`,
 * `create(() => {...})`, `computed(() => {...})`. Surface the LAST function-
 * shaped argument as the callback to descend into.
 */
function findCallbackInCall(call: SyntaxNode): SyntaxNode | null {
  const argList = findChild(call, 'ArgList')
  if (!argList) return null
  let last: SyntaxNode | null = null
  let c = argList.firstChild
  while (c) {
    if (c.name === 'ArrowFunction' || c.name === 'FunctionExpression') last = c
    c = c.nextSibling
  }
  return last
}

function extractObjectMembers(obj: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let p = obj.firstChild
  while (p) {
    if (p.name === 'Property') {
      const keyNode =
        findChild(p, 'PropertyDefinition') ??
        findChild(p, 'PropertyName') ??
        findChild(p, 'Number') ??
        findChild(p, 'String')
      if (keyNode) {
        let name = text.slice(keyNode.from, keyNode.to)
        // Strip surrounding quotes for string keys.
        if (name.startsWith('"') || name.startsWith("'")) {
          name = name.slice(1, -1)
        }
        // Determine kind by inspecting the value (last child of Property).
        const valueNode = lastChild(p)
        let kind: OutlineKind = 'property'
        let children: OutlineNode[] = []
        if (valueNode) {
          if (valueNode.name === 'ArrowFunction' || valueNode.name === 'FunctionExpression') {
            kind = 'method'
            const block = findChild(valueNode, 'Block')
            if (block) children = walkChildren(block, text, lineFor, false)
          } else if (valueNode.name === 'ObjectExpression') {
            kind = 'property'
            children = extractObjectMembers(valueNode, text, lineFor)
          } else if (valueNode.name === 'ClassExpression') {
            kind = 'class'
            const body = findChild(valueNode, 'ClassBody')
            if (body) children = walkChildren(body, text, lineFor, true)
          }
        }
        out.push(makeNode(kind, name, keyNode, lineFor, children))
      }
    }
    p = p.nextSibling
  }
  return out
}

function lastChild(node: SyntaxNode): SyntaxNode | null {
  let c = node.firstChild
  let last: SyntaxNode | null = null
  while (c) {
    last = c
    c = c.nextSibling
  }
  return last
}

/**
 * Walk a VariableDeclaration's children, pairing each VariableDefinition with
 * its initializer (if any), and produce one OutlineNode per binding. Supports
 * multi-binding declarations like `const a = 1, b = () => {}`.
 */
function makeFromVarDecl(node: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  // Determine kind keyword (let/var/const/using) by reading the leading text.
  const head = text.slice(node.from, node.from + 8)
  const isConst = /^const\b/.test(head)

  const bindings: { def: SyntaxNode; init: SyntaxNode | null }[] = []
  let pending: SyntaxNode | null = null
  let c = node.firstChild
  while (c) {
    if (c.name === 'VariableDefinition') {
      if (pending) bindings.push({ def: pending, init: null })
      pending = c
    } else if (pending && VAR_INITIALIZER_TYPES.has(c.name)) {
      bindings.push({ def: pending, init: c })
      pending = null
    }
    c = c.nextSibling
  }
  if (pending) bindings.push({ def: pending, init: null })

  const out: OutlineNode[] = []
  for (const b of bindings) {
    const name = text.slice(b.def.from, b.def.to)
    let kind: OutlineKind
    let children: OutlineNode[] = []
    if (b.init?.name === 'ClassExpression') {
      kind = 'class'
      const body = findChild(b.init, 'ClassBody')
      if (body) children = walkChildren(body, text, lineFor, true)
    } else if (b.init?.name === 'ArrowFunction' || b.init?.name === 'FunctionExpression') {
      kind = 'function'
      const block = findChild(b.init, 'Block')
      if (block) children = walkChildren(block, text, lineFor, false)
    } else if (b.init?.name === 'ObjectExpression') {
      kind = isConst ? 'constant' : 'variable'
      children = extractObjectMembers(b.init, text, lineFor)
    } else if (b.init?.name === 'CallExpression') {
      kind = isConst ? 'constant' : 'variable'
      const callback = findCallbackInCall(b.init)
      if (callback) {
        const block = findChild(callback, 'Block')
        if (block) children = walkChildren(block, text, lineFor, false)
      }
    } else {
      kind = isConst ? 'constant' : 'variable'
    }
    out.push(makeNode(kind, name, b.def, lineFor, children))
  }
  return out
}

function childText(node: SyntaxNode, type: string, text: string): string | null {
  const c = findChild(node, type)
  return c ? text.slice(c.from, c.to) : null
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  let c = node.firstChild
  while (c) {
    if (c.name === type) return c
    c = c.nextSibling
  }
  return null
}

function makeNode(
  kind: OutlineKind,
  name: string,
  node: SyntaxNode,
  lineFor: (offset: number) => number,
  children: OutlineNode[],
): OutlineNode {
  const line = lineFor(node.from)
  return {
    id: `${kind}:${name}:${line}:${node.from}`,
    name,
    kind,
    line,
    from: node.from,
    to: node.to,
    children,
  }
}

export const typescriptExtractor: Extractor = (text, ctx: ExtractContext) => {
  // Force a synchronous parse up to ~150ms; fall back to whatever incremental tree exists.
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  return walkChildren(tree.topNode, text, lineFor)
}
