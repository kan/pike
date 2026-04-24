import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { ExtractContext, Extractor, OutlineNode } from '../types'

/** Lezer node names → heading level. */
const ATX_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
}
const SETEXT_LEVELS: Record<string, number> = {
  SetextHeading1: 1,
  SetextHeading2: 2,
}

interface RawHeading {
  level: number
  name: string
  line: number
  from: number
  to: number
}

function readHeadingName(text: string, from: number, to: number, isSetext: boolean): string {
  const slice = text.slice(from, to)
  if (isSetext) {
    // First line is the title, second is the underline (=== or ---)
    const firstLine = slice.split('\n')[0] ?? ''
    return firstLine.trim()
  }
  // ATX: strip leading '#'s, leading/trailing whitespace, and trailing '#' run
  return slice
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

function nestByLevel(items: RawHeading[]): OutlineNode[] {
  const root: OutlineNode[] = []
  // Stack entries hold the OutlineNode and its level.
  const stack: { node: OutlineNode; level: number }[] = []

  for (const h of items) {
    const node: OutlineNode = {
      id: `heading:${h.level}:${h.line}`,
      name: h.name || `H${h.level}`,
      kind: 'heading',
      line: h.line,
      from: h.from,
      to: h.to,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    if (stack.length === 0) {
      root.push(node)
    } else {
      stack[stack.length - 1].node.children.push(node)
    }
    stack.push({ node, level: h.level })
  }

  return root
}

export const markdownExtractor: Extractor = (text: string, ctx: ExtractContext) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const headings: RawHeading[] = []

  tree.iterate({
    enter: (node) => {
      const atx = ATX_LEVELS[node.name]
      const setext = SETEXT_LEVELS[node.name]
      if (!atx && !setext) return
      const level = atx ?? setext
      const name = readHeadingName(text, node.from, node.to, !atx)
      const line = ctx.state.doc.lineAt(node.from).number
      headings.push({ level, name, line, from: node.from, to: node.to })
      // Don't descend into heading internals.
      return false
    },
  })

  return nestByLevel(headings)
}
