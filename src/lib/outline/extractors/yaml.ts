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

function unwrapKeyText(node: SyntaxNode, text: string): string {
  // Key may wrap Tagged/Anchored/Literal/QuotedLiteral
  let raw = text.slice(node.from, node.to).trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1)
  }
  return raw
}

function processMapping(map: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let c = map.firstChild
  while (c) {
    if (c.name === 'Pair') {
      const keyNode = findChild(c, 'Key')
      if (keyNode) {
        const name = unwrapKeyText(keyNode, text)
        // Look at the Pair's last child for the value (BlockMapping/Sequence/etc.)
        const valueNode = lastChildExcluding(c, ['Key'])
        let children: OutlineNode[] = []
        if (valueNode?.name === 'BlockMapping' || valueNode?.name === 'FlowMapping') {
          children = processMapping(valueNode, text, lineFor)
        }
        out.push(makeNode('key', name, keyNode, lineFor, children))
      }
    }
    c = c.nextSibling
  }
  return out
}

function lastChildExcluding(node: SyntaxNode, exclude: string[]): SyntaxNode | null {
  let c = node.firstChild
  let last: SyntaxNode | null = null
  while (c) {
    if (!exclude.includes(c.name)) last = c
    c = c.nextSibling
  }
  return last
}

export const yamlExtractor: Extractor = (text, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  const out: OutlineNode[] = []
  // Stream → Document(s) → element → BlockMapping (typically)
  let doc = tree.topNode.firstChild
  while (doc) {
    if (doc.name === 'Document') {
      // Walk the Document's descendants (skipping over single-element wrappers)
      let inner = doc.firstChild
      while (inner) {
        if (inner.name === 'BlockMapping' || inner.name === 'FlowMapping') {
          for (const n of processMapping(inner, text, lineFor)) out.push(n)
        }
        inner = inner.nextSibling
      }
    }
    doc = doc.nextSibling
  }
  return out
}
