import type { ExtractContext, Extractor, OutlineKind, OutlineNode } from '../types'

const FUNC_RE = /^func\s+(?:\(\s*[^)]*\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/
const TYPE_BLOCK_RE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])?\s+(struct|interface)\s*\{(\s*\})?\s*$/
const TYPE_SIMPLE_RE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(=?)/
const CONST_VAR_SINGLE_RE = /^(const|var)\s+([A-Za-z_][A-Za-z0-9_]*)/
const BLOCK_START_RE = /^(const|var|type)\s*\(\s*$/
const BLOCK_END_RE = /^\)\s*$/
/** Inside `type ( ... )` block: `Name <body>` */
const TYPE_GROUP_ENTRY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)/
/** Inside struct body: `Name [Name2,...] Type` or just `Type` (embedded) */
const FIELD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+\S/
/** Embedded type: just `*Foo` or `Foo` or `pkg.Foo` */
const EMBEDDED_RE = /^\s*\*?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*(?:\/\/.*)?$/
/** Interface method: `Name(...) ...` */
const METHOD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/

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

interface State {
  out: OutlineNode[]
  /** receiver type name → its outline node (so methods can attach as children) */
  typeMap: Map<string, OutlineNode>
}

function attachOrPush(state: State, node: OutlineNode, recv?: string): void {
  if (recv && state.typeMap.has(recv)) {
    const parent = state.typeMap.get(recv)
    if (parent) {
      parent.children.push(node)
      return
    }
  }
  state.out.push(node)
}

export const goExtractor: Extractor = (text: string, _ctx: ExtractContext) => {
  const lines = text.split('\n')
  const state: State = { out: [], typeMap: new Map() }

  let inGroup: 'const' | 'var' | 'type' | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimRight = line.trimEnd()
    const lineNum = i + 1
    const lineStart = offsetOfLine(text, lineNum)

    // Inside grouped const/var/type block: `const ( ... )`
    if (inGroup) {
      if (BLOCK_END_RE.test(trimRight)) {
        inGroup = null
        i++
        continue
      }
      const t = line.trim()
      if (!t || t.startsWith('//')) {
        i++
        continue
      }
      const m = t.match(TYPE_GROUP_ENTRY_RE)
      if (m) {
        const indent = line.length - line.trimStart().length
        const from = lineStart + indent
        const to = from + t.length
        let kind: OutlineKind
        if (inGroup === 'const') kind = 'constant'
        else if (inGroup === 'var') kind = 'variable'
        else kind = 'type'
        const node = makeNode(kind, m[1], lineNum, from, to)
        if (inGroup === 'type') state.typeMap.set(m[1], node)
        state.out.push(node)
      }
      i++
      continue
    }

    // Top-level only (no leading whitespace)
    if (line.startsWith(' ') || line.startsWith('\t')) {
      i++
      continue
    }

    // Grouped block start
    const groupM = trimRight.match(BLOCK_START_RE)
    if (groupM) {
      inGroup = groupM[1] as 'const' | 'var' | 'type'
      i++
      continue
    }

    // type Foo struct { … } / type Foo interface { … }
    const tb = trimRight.match(TYPE_BLOCK_RE)
    if (tb) {
      const name = tb[1]
      const sub = tb[2] as 'struct' | 'interface'
      const isEmpty = !!tb[3]
      const node = makeNode(sub, name, lineNum, lineStart, lineStart + trimRight.length)
      state.typeMap.set(name, node)
      state.out.push(node)
      if (!isEmpty) {
        // Collect body until line matching `}` at column 0
        let j = i + 1
        while (j < lines.length) {
          const bl = lines[j]
          if (/^\}\s*$/.test(bl.trimEnd())) break
          // Skip blank/comment
          const t = bl.trim()
          if (t && !t.startsWith('//')) {
            const blStart = offsetOfLine(text, j + 1)
            const indent = bl.length - bl.trimStart().length
            if (sub === 'struct') {
              const fm = bl.match(FIELD_RE)
              if (fm) {
                const names = fm[1].split(/\s*,\s*/)
                for (const fname of names) {
                  node.children.push(makeNode('field', fname, j + 1, blStart + indent, blStart + indent + fname.length))
                }
              } else {
                const em = bl.match(EMBEDDED_RE)
                if (em) {
                  node.children.push(makeNode('field', em[1], j + 1, blStart + indent, blStart + bl.trimEnd().length))
                }
              }
            } else {
              // interface
              const mm = bl.match(METHOD_RE)
              if (mm) {
                node.children.push(makeNode('method', mm[1], j + 1, blStart + indent, blStart + bl.trimEnd().length))
              } else {
                const em = bl.match(EMBEDDED_RE)
                if (em) {
                  node.children.push(makeNode('field', em[1], j + 1, blStart + indent, blStart + bl.trimEnd().length))
                }
              }
            }
          }
          j++
        }
        i = j + 1
        continue
      }
      i++
      continue
    }

    // func [recv] Name(...)
    const fm = trimRight.match(FUNC_RE)
    if (fm) {
      const recv = fm[1] // may be undefined
      const name = fm[2]
      const node = makeNode(recv ? 'method' : 'function', name, lineNum, lineStart, lineStart + trimRight.length)
      attachOrPush(state, node, recv)
      i++
      continue
    }

    // type Name <type or alias>
    const ts = trimRight.match(TYPE_SIMPLE_RE)
    if (ts) {
      const name = ts[1]
      const node = makeNode('type', name, lineNum, lineStart, lineStart + trimRight.length)
      state.typeMap.set(name, node)
      state.out.push(node)
      i++
      continue
    }

    // single-line const/var
    const cv = trimRight.match(CONST_VAR_SINGLE_RE)
    if (cv) {
      state.out.push(
        makeNode(cv[1] === 'const' ? 'constant' : 'variable', cv[2], lineNum, lineStart, lineStart + trimRight.length),
      )
    }
    i++
  }

  return state.out
}
