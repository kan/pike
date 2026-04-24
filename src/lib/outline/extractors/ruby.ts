import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'
import { buildLineOffsets, lineStart } from './_util'

const DECL_RE = /^(\s*)(class|module|def)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[?!=]?)/

interface RawDecl {
  indent: number
  kind: 'class' | 'module' | 'def'
  name: string
  line: number
  from: number
  to: number
}

export const rubyExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const offsets = buildLineOffsets(text)
  const items: RawDecl[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(DECL_RE)
    if (!m) continue
    const indent = m[1].length
    const kind = m[2] as 'class' | 'module' | 'def'
    const name = m[3]
    const lineNum = i + 1
    const from = lineStart(offsets, lineNum) + indent
    const to = from + line.trimEnd().length - indent
    items.push({ indent, kind, name, line: lineNum, from, to })
  }

  const root: OutlineNode[] = []
  const stack: { node: OutlineNode; indent: number; isContainer: boolean }[] = []
  for (const it of items) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= it.indent) stack.pop()
    const parent = stack[stack.length - 1]
    let kind: OutlineKind
    if (it.kind === 'class') kind = 'class'
    else if (it.kind === 'module') kind = 'module'
    else kind = parent?.isContainer ? 'method' : 'function'
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
    stack.push({ node, indent: it.indent, isContainer: it.kind === 'class' || it.kind === 'module' })
  }
  return root
}
