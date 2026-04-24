import type { ExtractContext, Extractor, OutlineNode } from '../types'

const FROM_RE = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i

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

export const dockerfileExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const nodes: OutlineNode[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(FROM_RE)
    if (!m) continue
    const image = m[1]
    const alias = m[2]
    const name = alias ?? image
    const detail = alias ? image : undefined
    const lineNum = i + 1
    const from = offsetOfLine(text, lineNum)
    const to = from + line.trimEnd().length
    nodes.push({
      id: `module:${name}:${lineNum}:${from}`,
      name,
      detail,
      kind: 'module',
      line: lineNum,
      from,
      to,
      children: [],
    })
  }
  return nodes
}
