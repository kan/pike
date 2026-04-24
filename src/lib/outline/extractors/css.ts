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

function takeHeader(node: SyntaxNode, text: string): string {
  // Header = text from start of node to the first Block child (or end of node).
  const block = findChild(node, 'Block')
  const end = block ? block.from : node.to
  return text.slice(node.from, end).replace(/\s+/g, ' ').trim()
}

function handleItem(node: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode | null {
  switch (node.name) {
    case 'RuleSet': {
      const header = takeHeader(node, text)
      return makeNode('section', header || '(rule)', node, lineFor)
    }
    case 'MediaStatement': {
      const header = takeHeader(node, text)
      return makeNode('section', header || '@media', node, lineFor)
    }
    case 'SupportsStatement': {
      const header = takeHeader(node, text)
      return makeNode('section', header || '@supports', node, lineFor)
    }
    case 'KeyframesStatement': {
      const nameN = findChild(node, 'KeyframeName')
      const name = nameN ? text.slice(nameN.from, nameN.to) : ''
      return makeNode('section', `@keyframes ${name}`.trim(), node, lineFor)
    }
    case 'ImportStatement':
    case 'CharsetStatement':
    case 'NamespaceStatement': {
      return makeNode('section', takeHeader(node, text) || node.name, node, lineFor)
    }
    case 'AtRule': {
      return makeNode('section', takeHeader(node, text) || '@rule', node, lineFor)
    }
    default:
      return null
  }
}

/** Walk any container's direct children and surface CSS top-level items. */
export function walkCssChildren(parent: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let c = parent.firstChild
  while (c) {
    const n = handleItem(c, text, lineFor)
    if (n) out.push(n)
    c = c.nextSibling
  }
  return out
}

export const cssExtractor: Extractor = (text, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  return walkCssChildren(tree.topNode, text, lineFor)
}
