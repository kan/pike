import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const LANDMARKS = new Set(['section', 'article', 'nav', 'header', 'footer', 'main', 'aside'])

interface ElementInfo {
  kind: OutlineKind
  name: string
  detail?: string
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  let c = node.firstChild
  while (c) {
    if (c.name === type) return c
    c = c.nextSibling
  }
  return null
}

function getAttribute(tag: SyntaxNode, text: string, attrName: string): string | null {
  let c = tag.firstChild
  while (c) {
    if (c.name === 'Attribute') {
      const nameN = findChild(c, 'AttributeName')
      const valN = findChild(c, 'AttributeValue') ?? findChild(c, 'UnquotedAttributeValue')
      if (nameN && valN) {
        const n = text.slice(nameN.from, nameN.to)
        if (n.toLowerCase() === attrName) {
          let v = text.slice(valN.from, valN.to)
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1)
          }
          return v
        }
      }
    }
    c = c.nextSibling
  }
  return null
}

function innerText(el: SyntaxNode, text: string): string {
  const open = findChild(el, 'OpenTag')
  const close = findChild(el, 'CloseTag')
  if (!open) return ''
  const start = open.to
  const end = close ? close.from : el.to
  if (end <= start) return ''
  // Strip tags iteratively so nested patterns like `<scr<x>ipt>` don't leave
  // `<script>` after a single pass.
  let stripped = text.slice(start, end)
  while (true) {
    const next = stripped.replace(/<[^>]+>/g, '')
    if (next === stripped) break
    stripped = next
  }
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function inspectElement(el: SyntaxNode, text: string): ElementInfo | null {
  const tag = findChild(el, 'OpenTag') ?? findChild(el, 'SelfClosingTag')
  if (!tag) return null
  const tagNameNode = findChild(tag, 'TagName')
  if (!tagNameNode) return null
  const tagName = text.slice(tagNameNode.from, tagNameNode.to)
  const lower = tagName.toLowerCase()
  const id = getAttribute(tag, text, 'id')
  const cls = getAttribute(tag, text, 'class')

  // Build display name: tag, optionally with #id and/or first .class
  let name = tagName
  if (id) name += `#${id}`
  if (!id && cls) {
    const first = cls.trim().split(/\s+/)[0]
    if (first) name += `.${first}`
  }

  // Choose icon kind by tag role
  let kind: OutlineKind
  if (HEADINGS.has(lower)) kind = 'heading'
  else if (LANDMARKS.has(lower)) kind = 'section'
  else if (/^[A-Z]/.test(tagName) || tagName.includes('-')) kind = 'module'
  else kind = 'property'

  const detail = HEADINGS.has(lower) ? innerText(el, text) : undefined
  return { kind, name, detail }
}

function makeNode(
  kind: OutlineKind,
  name: string,
  detail: string | undefined,
  el: SyntaxNode,
  lineFor: (offset: number) => number,
  children: OutlineNode[],
): OutlineNode {
  const line = lineFor(el.from)
  return {
    id: `${kind}:${name}:${line}:${el.from}`,
    name,
    detail: detail || undefined,
    kind,
    line,
    from: el.from,
    to: el.to,
    children,
  }
}

function processElement(el: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const childOutline: OutlineNode[] = []
  let c = el.firstChild
  while (c) {
    if (c.name === 'Element') {
      for (const n of processElement(c, text, lineFor)) childOutline.push(n)
    }
    c = c.nextSibling
  }
  const info = inspectElement(el, text)
  if (!info) return childOutline
  return [makeNode(info.kind, info.name, info.detail, el, lineFor, childOutline)]
}

/**
 * Walk children of any node, gathering outline nodes from any Element descendants.
 * Used by `htmlExtractor` (top-level Document) and by Vue's template handler.
 */
export function walkHtmlChildren(parent: SyntaxNode, text: string, lineFor: (offset: number) => number): OutlineNode[] {
  const out: OutlineNode[] = []
  let c = parent.firstChild
  while (c) {
    if (c.name === 'Element') {
      for (const n of processElement(c, text, lineFor)) out.push(n)
    }
    c = c.nextSibling
  }
  return out
}

export const htmlExtractor: Extractor = (text, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  return walkHtmlChildren(tree.topNode, text, lineFor)
}
