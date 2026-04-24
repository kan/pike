import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

/** Match `def name(`, `async def name(`, or `class Name(` / `class Name:`. */
const DEF_RE = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/

interface RawDecl {
  indent: number
  kind: 'def' | 'class'
  name: string
  line: number
  from: number
  to: number
}

function offsetOfLine(text: string, lineNum: number): number {
  let pos = 0
  let line = 1
  while (line < lineNum && pos < text.length) {
    const nl = text.indexOf('\n', pos)
    if (nl < 0) return text.length
    pos = nl + 1
    line++
  }
  return pos
}

function nestByIndent(items: RawDecl[]): OutlineNode[] {
  const root: OutlineNode[] = []
  const stack: { node: OutlineNode; indent: number; isClass: boolean }[] = []

  for (const it of items) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= it.indent) {
      stack.pop()
    }
    let kind: OutlineKind
    if (it.kind === 'class') {
      kind = 'class'
    } else {
      // `def` inside a class → method, otherwise function
      const parent = stack[stack.length - 1]
      kind = parent?.isClass ? 'method' : 'function'
    }
    const node: OutlineNode = {
      id: `${kind}:${it.name}:${it.line}:${it.from}`,
      name: it.name,
      kind,
      line: it.line,
      from: it.from,
      to: it.to,
      children: [],
    }
    if (stack.length === 0) root.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, indent: it.indent, isClass: it.kind === 'class' })
  }
  return root
}

export const pythonExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const items: RawDecl[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(DEF_RE)
    if (!m) continue
    const indent = m[1].length
    const kind = m[2] as 'def' | 'class'
    const name = m[3]
    const lineNum = i + 1
    const from = offsetOfLine(text, lineNum) + indent
    const to = from + line.trimEnd().length - indent
    items.push({ indent, kind, name, line: lineNum, from, to })
  }
  return nestByIndent(items)
}
