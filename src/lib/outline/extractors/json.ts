import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

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
  children: OutlineNode[] = [],
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

function processObject(obj: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let c = obj.firstChild
  while (c) {
    if (c.name === 'Property') {
      const keyNode = findChild(c, 'PropertyName')
      if (keyNode) {
        let name = text.slice(keyNode.from, keyNode.to)
        if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
        // The value is the last child of Property (after PropertyName and ':')
        const valueNode = lastChild(c)
        let children: OutlineNode[] = []
        if (valueNode?.name === 'Object') children = processObject(valueNode, text, lineFor)
        out.push(makeNode('key', name, keyNode, lineFor, children))
      }
    }
    c = c.nextSibling
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

export const jsonExtractor: Extractor = (text, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  // JsonText → value → (Object | Array | scalar)
  const obj = findChild(tree.topNode, 'Object')
  if (!obj) return []
  return processObject(obj, text, lineFor)
}
