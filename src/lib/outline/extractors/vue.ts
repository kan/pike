import type { SyntaxNode } from '@lezer/common'
import { parser as cssParser } from '@lezer/css'
import { parser as htmlParser } from '@lezer/html'
import { parser as jsParser } from '@lezer/javascript'
import type { ExtractContext, Extractor, OutlineNode } from '../types'
import { walkCssChildren } from './css'
import { walkHtmlChildren } from './html'
import { walkJsChildren } from './typescript'

function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function shiftNodes(nodes: OutlineNode[], lineDelta: number, offsetDelta: number): void {
  for (const n of nodes) {
    n.line += lineDelta
    n.from += offsetDelta
    n.to += offsetDelta
    n.id = `${n.kind}:${n.name}:${n.line}:${n.from}`
    if (n.children.length > 0) shiftNodes(n.children, lineDelta, offsetDelta)
  }
}

function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  let c = node.firstChild
  while (c) {
    if (c.name === type) return c
    c = c.nextSibling
  }
  return null
}

function getTagName(el: SyntaxNode, text: string): string | null {
  const tag = findChild(el, 'OpenTag') ?? findChild(el, 'SelfClosingTag')
  if (!tag) return null
  const t = findChild(tag, 'TagName')
  return t ? text.slice(t.from, t.to) : null
}

function getAttrsDetail(el: SyntaxNode, text: string): string | undefined {
  const tag = findChild(el, 'OpenTag') ?? findChild(el, 'SelfClosingTag')
  if (!tag) return undefined
  const parts: string[] = []
  let c = tag.firstChild
  while (c) {
    if (c.name === 'Attribute') {
      parts.push(text.slice(c.from, c.to))
    }
    c = c.nextSibling
  }
  if (parts.length === 0) return undefined
  return parts.join(' ').replace(/\s+/g, ' ')
}

/** Inner content range = right after OpenTag end → start of CloseTag (or end of element). */
function innerRange(el: SyntaxNode): { from: number; to: number } | null {
  const open = findChild(el, 'OpenTag')
  const close = findChild(el, 'CloseTag')
  if (!open) return null
  const from = open.to
  const to = close ? close.from : el.to
  if (to < from) return null
  return { from, to }
}

export const vueExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  // Parse the whole SFC as HTML so that top-level template/script/style are
  // resolved with proper tag balancing (regex would mismatch on nested
  // <template> elements inside the SFC template block).
  const tree = htmlParser.parse(text)
  const lineFor = (offset: number) => lineOfOffset(text, offset)

  const out: OutlineNode[] = []
  let c = tree.topNode.firstChild
  while (c) {
    if (c.name === 'Element') {
      const tagName = getTagName(c, text)
      if (tagName === 'template' || tagName === 'script' || tagName === 'style') {
        const detail = getAttrsDetail(c, text)
        const fromLine = lineFor(c.from)
        const section: OutlineNode = {
          id: `section:${tagName}:${fromLine}:${c.from}`,
          name: tagName,
          detail,
          kind: 'section',
          line: fromLine,
          from: c.from,
          to: c.to,
          children: [],
        }
        const inner = innerRange(c)
        if (inner) {
          if (tagName === 'template') {
            // Walk the already-parsed Element directly (offsets are outer).
            section.children = walkHtmlChildren(c, text, lineFor)
          } else if (tagName === 'script') {
            const innerText = text.slice(inner.from, inner.to)
            try {
              const jsTree = jsParser.parse(innerText)
              const innerLineFor = (off: number) => lineOfOffset(innerText, off)
              const ch = walkJsChildren(jsTree.topNode, innerText, innerLineFor)
              shiftNodes(ch, lineFor(inner.from) - 1, inner.from)
              section.children = ch
            } catch {}
          } else if (tagName === 'style') {
            const innerText = text.slice(inner.from, inner.to)
            try {
              const cssTree = cssParser.parse(innerText)
              const innerLineFor = (off: number) => lineOfOffset(innerText, off)
              const ch = walkCssChildren(cssTree.topNode, innerText, innerLineFor)
              shiftNodes(ch, lineFor(inner.from) - 1, inner.from)
              section.children = ch
            } catch {}
          }
        }
        out.push(section)
      }
    }
    c = c.nextSibling
  }

  out.sort((a, b) => a.from - b.from)
  return out
}
