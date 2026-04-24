import type { ExtractContext, Extractor, OutlineNode } from '../types'

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:+?]?=/

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

/** Extract target names from a rule line like `foo bar: deps` → ['foo', 'bar']. */
function parseTargetLine(line: string): string[] | null {
  if (line.startsWith('\t')) return null
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) return null

  // Find first ':' that isn't part of ':=' or '::='. '::' (double-colon rule) is OK.
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '=') return null // assignment before any target-colon → not a rule
    if (ch === '#') return null
    if (ch === ':') {
      if (line[i + 1] === '=') return null
      colon = i
      break
    }
  }
  if (colon < 0) return null

  const head = line.slice(0, colon).trim()
  if (!head) return null
  // Multiple targets on one line: split on whitespace
  const names = head.split(/\s+/).filter(Boolean)
  return names.length > 0 ? names : null
}

export const makefileExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const nodes: OutlineNode[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1
    const lineStart = offsetOfLine(text, lineNum)

    // Top-level variable assignment (skip indented/recipe lines)
    if (!line.startsWith('\t')) {
      const am = line.trimStart().match(ASSIGN_RE)
      if (am) {
        const indent = line.length - line.trimStart().length
        const name = am[1]
        nodes.push({
          id: `variable:${name}:${lineNum}:${lineStart + indent}`,
          name,
          kind: 'variable',
          line: lineNum,
          from: lineStart + indent,
          to: lineStart + line.trimEnd().length,
          children: [],
        })
        continue
      }
    }

    const targets = parseTargetLine(line)
    if (!targets) continue

    for (const name of targets) {
      // Skip special directives like .PHONY, .SUFFIXES — they declare targets elsewhere
      if (name === '.PHONY' || name === '.SUFFIXES' || name === '.DEFAULT' || name === '.SECONDARY') continue
      const key = `${name}:${lineNum}`
      if (seen.has(key)) continue
      seen.add(key)
      nodes.push({
        id: `function:${name}:${lineNum}:${lineStart}`,
        name,
        kind: 'function',
        line: lineNum,
        from: lineStart,
        to: lineStart + line.trimEnd().length,
        children: [],
      })
    }
  }
  return nodes
}
