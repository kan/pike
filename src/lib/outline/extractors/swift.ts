import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

const MODIFIER =
  /^(public|private|fileprivate|internal|open|final|static|mutating|override|required|convenience|indirect|lazy|dynamic|weak|unowned|@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)\s+/

/** `class` used as a modifier (class func, class var) — strip it. */
const CLASS_AS_MODIFIER = /^class\s+(?=func\b|var\b|let\b|subscript\b)/

const TYPE_DECL = /^(class|struct|enum|protocol|extension)\s+(?:`([^`]+)`|([A-Z][A-Za-z0-9_]*))/
const MEMBER_DECL = /^(func|var|let|init|subscript)\s*(?:<[^>]+>\s*)?(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))?/

interface RawDecl {
  indent: number
  kind: 'class' | 'struct' | 'enum' | 'protocol' | 'extension' | 'func' | 'var' | 'let' | 'init' | 'subscript'
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
  s = s.replace(CLASS_AS_MODIFIER, '')
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

export const swiftExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const items: RawDecl[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indentMatch = line.match(/^(\s*)/)
    const indent = indentMatch?.[1].length ?? 0
    const body = stripModifiers(line.slice(indent))

    let kind: RawDecl['kind'] | null = null
    let name: string | null = null

    const tm = body.match(TYPE_DECL)
    if (tm) {
      kind = tm[1] as RawDecl['kind']
      name = tm[2] ?? tm[3] ?? null
    } else {
      const mm = body.match(MEMBER_DECL)
      if (mm) {
        kind = mm[1] as RawDecl['kind']
        name = mm[2] ?? mm[3] ?? (kind === 'init' || kind === 'subscript' ? kind : null)
      }
    }

    if (!kind || !name) continue
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
    else if (it.kind === 'struct') kind = 'struct'
    else if (it.kind === 'enum') kind = 'enum'
    else if (it.kind === 'protocol') kind = 'interface'
    else if (it.kind === 'extension') kind = 'namespace'
    else if (it.kind === 'func') kind = parent?.isContainer ? 'method' : 'function'
    else if (it.kind === 'init') kind = 'constructor'
    else if (it.kind === 'subscript') kind = 'method'
    else if (it.kind === 'var') kind = parent?.isContainer ? 'property' : 'variable'
    else kind = parent?.isContainer ? 'property' : 'constant'
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
    const isContainer =
      it.kind === 'class' ||
      it.kind === 'struct' ||
      it.kind === 'enum' ||
      it.kind === 'protocol' ||
      it.kind === 'extension'
    stack.push({ node, indent: it.indent, isContainer })
  }
  return root
}
