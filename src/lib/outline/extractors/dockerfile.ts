import type { ExtractContext, Extractor, OutlineNode } from '../types'
import { buildLineOffsets, lineStart } from './_util'

const FROM_RE = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i

export const dockerfileExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const offsets = buildLineOffsets(text)
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
    const from = lineStart(offsets, lineNum)
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
