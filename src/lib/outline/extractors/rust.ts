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

function nameOf(node: SyntaxNode, type: string, text: string, fallback = '(anonymous)'): string {
  const c = findChild(node, type)
  return c ? text.slice(c.from, c.to) : fallback
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

/** ImplItem name: text from after `impl` keyword up to start of DeclarationList. */
function implName(node: SyntaxNode, text: string): string {
  const decls = findChild(node, 'DeclarationList')
  const end = decls ? decls.from : node.to
  let header = text.slice(node.from, end)
  // Drop leading 'unsafe '? 'impl '
  header = header.replace(/^\s*(unsafe\s+)?impl\b\s*/, '')
  return header.replace(/\s+/g, ' ').trim() || '(impl)'
}

function handle(node: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode | null {
  switch (node.name) {
    case 'AttributeItem': {
      // Wraps a declarationStatement; recurse into children to find it.
      let c = node.firstChild
      while (c) {
        const r = handle(c, text, lineFor)
        if (r) return r
        c = c.nextSibling
      }
      return null
    }
    case 'FunctionItem': {
      const name = nameOf(node, 'BoundIdentifier', text)
      const block = findChild(node, 'Block')
      const inner = block ? walkChildren(block, text, lineFor) : []
      return makeNode('function', name, node, lineFor, inner)
    }
    case 'StructItem': {
      const name = nameOf(node, 'TypeIdentifier', text)
      const fields = findChild(node, 'FieldDeclarationList')
      const members: OutlineNode[] = []
      if (fields) {
        let f = fields.firstChild
        while (f) {
          if (f.name === 'FieldDeclaration') {
            const fname = nameOf(f, 'FieldIdentifier', text, '(field)')
            members.push(makeNode('field', fname, f, lineFor))
          }
          f = f.nextSibling
        }
      }
      return makeNode('struct', name, node, lineFor, members)
    }
    case 'UnionItem': {
      const name = nameOf(node, 'TypeIdentifier', text)
      return makeNode('struct', name, node, lineFor)
    }
    case 'EnumItem': {
      const name = nameOf(node, 'TypeIdentifier', text)
      const list = findChild(node, 'EnumVariantList')
      const variants: OutlineNode[] = []
      if (list) {
        let v = list.firstChild
        while (v) {
          if (v.name === 'EnumVariant') {
            const vname = nameOf(v, 'Identifier', text, '(variant)')
            variants.push(makeNode('enumMember', vname, v, lineFor))
          }
          v = v.nextSibling
        }
      }
      return makeNode('enum', name, node, lineFor, variants)
    }
    case 'TraitItem': {
      const name = nameOf(node, 'TypeIdentifier', text)
      const decls = findChild(node, 'DeclarationList')
      const inner = decls ? walkChildren(decls, text, lineFor) : []
      return makeNode('trait', name, node, lineFor, inner)
    }
    case 'ImplItem': {
      const decls = findChild(node, 'DeclarationList')
      const inner = decls ? walkChildren(decls, text, lineFor) : []
      return makeNode('impl', implName(node, text), node, lineFor, inner)
    }
    case 'TypeItem': {
      const name = nameOf(node, 'TypeIdentifier', text)
      return makeNode('type', name, node, lineFor)
    }
    case 'ConstItem': {
      const name = nameOf(node, 'BoundIdentifier', text)
      return makeNode('constant', name, node, lineFor)
    }
    case 'StaticItem': {
      const name = nameOf(node, 'BoundIdentifier', text)
      return makeNode('constant', name, node, lineFor)
    }
    case 'ModItem': {
      const name = nameOf(node, 'BoundIdentifier', text)
      const decls = findChild(node, 'DeclarationList')
      const inner = decls ? walkChildren(decls, text, lineFor) : []
      return makeNode('module', name, node, lineFor, inner)
    }
    case 'ForeignModItem': {
      const decls = findChild(node, 'DeclarationList')
      const inner = decls ? walkChildren(decls, text, lineFor) : []
      return makeNode('module', 'extern', node, lineFor, inner)
    }
    case 'MacroDefinition': {
      const name = nameOf(node, 'Identifier', text)
      return makeNode('macro', name, node, lineFor)
    }
    default:
      return null
  }
}

function walkChildren(parent: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let c = parent.firstChild
  while (c) {
    const n = handle(c, text, lineFor)
    if (n) out.push(n)
    c = c.nextSibling
  }
  return out
}

export const rustExtractor: Extractor = (text, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  return walkChildren(tree.topNode, text, lineFor)
}
