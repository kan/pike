import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'
import { buildLineOffsets, lineStart } from './_util'

const MODIFIER = /^(public|private|protected|final|abstract|static|readonly)\s+/

const DECL_RE = /^(class|interface|trait|enum|namespace|function)\s+&?([A-Za-z_\\][A-Za-z0-9_\\]*)/

interface RawDecl {
  indent: number
  kind: 'class' | 'interface' | 'trait' | 'enum' | 'namespace' | 'function'
  name: string
  line: number
  from: number
  to: number
}

function stripModifiers(s: string): string {
  let changed = true
  while (changed) {
    changed = false
    const m = s.match(MODIFIER)
    if (m) {
      s = s.slice(m[0].length)
      changed = true
    }
  }
  return s
}

export const phpExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const offsets = buildLineOffsets(text)
  const items: RawDecl[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indentMatch = line.match(/^(\s*)/)
    const indent = indentMatch?.[1].length ?? 0
    const body = stripModifiers(line.slice(indent))
    const m = body.match(DECL_RE)
    if (!m) continue
    const kind = m[1] as RawDecl['kind']
    const name = m[2]
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
    else if (it.kind === 'interface') kind = 'interface'
    else if (it.kind === 'trait') kind = 'trait'
    else if (it.kind === 'enum') kind = 'enum'
    else if (it.kind === 'namespace') kind = 'namespace'
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
    stack.push({
      node,
      indent: it.indent,
      isContainer:
        it.kind === 'class' ||
        it.kind === 'interface' ||
        it.kind === 'trait' ||
        it.kind === 'enum' ||
        it.kind === 'namespace',
    })
  }
  return root
}
