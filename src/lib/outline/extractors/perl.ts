import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

const PACKAGE_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_:]*)/
const SUB_RE = /^\s*sub\s+([A-Za-z_][A-Za-z0-9_]*)/

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

function makeNode(kind: OutlineKind, name: string, lineNum: number, from: number, to: number): OutlineNode {
  return {
    id: `${kind}:${name}:${lineNum}:${from}`,
    name,
    kind,
    line: lineNum,
    from,
    to,
    children: [],
  }
}

export const perlExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const out: OutlineNode[] = []
  let currentPkg: OutlineNode | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    const lineStart = offsetOfLine(text, lineNum)

    const pkg = line.match(PACKAGE_RE)
    if (pkg) {
      const node = makeNode('namespace', pkg[1], lineNum, lineStart, lineStart + line.trimEnd().length)
      out.push(node)
      currentPkg = node
      continue
    }
    const sub = line.match(SUB_RE)
    if (sub) {
      const node = makeNode('function', sub[1], lineNum, lineStart, lineStart + line.trimEnd().length)
      if (currentPkg) currentPkg.children.push(node)
      else out.push(node)
    }
  }
  return out
}
