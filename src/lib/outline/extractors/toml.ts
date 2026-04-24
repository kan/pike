import type { ExtractContext, Extractor, OutlineNode } from '../types'

const TABLE_RE = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*$/

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

function splitKey(key: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes: '"' | "'" | null = null
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (inQuotes) {
      if (ch === inQuotes) inQuotes = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      inQuotes = ch as '"' | "'"
    } else if (ch === '.') {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

export const tomlExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const root: OutlineNode[] = []
  // Map of dotted key → node at that level (for nesting).
  const seen = new Map<string, OutlineNode>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(TABLE_RE)
    if (!m) continue
    const isArray = m[1] === '[['
    const rawKey = m[2]
    const parts = splitKey(rawKey)
    if (parts.length === 0) continue
    const lineNum = i + 1
    const from = offsetOfLine(text, lineNum)
    const to = from + line.trimEnd().length

    let parent: OutlineNode | null = null
    for (let p = 0; p < parts.length - 1; p++) {
      const prefix = parts.slice(0, p + 1).join('.')
      let node = seen.get(prefix)
      if (!node) {
        node = {
          id: `section:${prefix}:0:0`,
          name: parts[p],
          kind: 'section',
          line: lineNum,
          from,
          to,
          children: [],
        }
        seen.set(prefix, node)
        if (parent) parent.children.push(node)
        else root.push(node)
      }
      parent = node
    }

    const leafKey = parts[parts.length - 1]
    const dotted = parts.join('.')
    const leafName = isArray ? `${leafKey}[]` : leafKey
    const leafId = `section:${dotted}:${lineNum}:${from}`
    const leafNode: OutlineNode = {
      id: leafId,
      name: leafName,
      kind: 'section',
      line: lineNum,
      from,
      to,
      children: [],
    }
    // If a placeholder for this dotted key was already created as a parent for a
    // deeper entry, merge: keep the placeholder's children, update its line/from/to/name.
    const existing = seen.get(dotted)
    if (existing) {
      existing.name = leafName
      existing.line = lineNum
      existing.from = from
      existing.to = to
      existing.id = leafId
    } else {
      seen.set(dotted, leafNode)
      if (parent) parent.children.push(leafNode)
      else root.push(leafNode)
    }
  }
  return root
}
