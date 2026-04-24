import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

const MODIFIER =
  /^(public|private|internal|protected|open|final|abstract|sealed|data|inner|enum|annotation|companion|override|suspend|inline|external|expect|actual|operator|infix|tailrec|lateinit|const)\s+/

const DECL_RE = /^(class|interface|object|fun|val|var)\s+(?:<[^>]+>\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/

interface RawDecl {
  indent: number
  kind: 'class' | 'interface' | 'object' | 'fun' | 'val' | 'var'
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

export const kotlinExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const items: RawDecl[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indentMatch = line.match(/^(\s*)/)
    const indent = indentMatch?.[1].length ?? 0
    const body = stripModifiers(line.slice(indent))
    const m = body.match(DECL_RE)
    if (!m) continue
    const kind = m[1] as RawDecl['kind']
    const name = m[2].replace(/^`|`$/g, '')
    const lineNum = i + 1
    const from = offsetOfLine(text, lineNum) + indent
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
    else if (it.kind === 'object') kind = 'module'
    else if (it.kind === 'fun') kind = parent?.isContainer ? 'method' : 'function'
    else if (it.kind === 'val') kind = parent?.isContainer ? 'property' : 'constant'
    else kind = parent?.isContainer ? 'field' : 'variable'
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
      isContainer: it.kind === 'class' || it.kind === 'interface' || it.kind === 'object',
    })
  }
  return root
}
