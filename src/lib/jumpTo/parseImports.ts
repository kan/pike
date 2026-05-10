/**
 * Import statement extraction for TS/JS/Vue/Go.
 * Returns absolute (text-relative) offsets of the source string so callers
 * can detect a click on the path and open the resolved file.
 *
 * This is a pragmatic regex-based parser — not a full TS/JS lexer. It covers
 * the common shapes seen in real projects and intentionally errs on the side
 * of false negatives (missed imports) over false positives (wrong source).
 */

export interface ImportEntry {
  /** Raw source string as written (unresolved). */
  source: string
  /** Offset of the first char of the source string in the original text. */
  sourceFrom: number
  /** Offset just past the last char of the source string. */
  sourceTo: number
  /** `import X from ...` */
  defaultName?: string
  /** `import * as X from ...` */
  namespaceName?: string
  /** `import { a, b as c } from ...` (imported = exported name, local = local binding) */
  named: { imported: string; local: string }[]
}

export function parseImports(text: string, langId: string): ImportEntry[] {
  if (langId === 'vue') return parseImportsVue(text)
  if (langId === 'go') return parseImportsGo(text)
  return parseImportsTsLike(text)
}

function parseImportsTsLike(text: string): ImportEntry[] {
  const out: ImportEntry[] = []

  // import ...head... from "source"
  // m[0] spans from the leading anchor through the closing quote (inclusive).
  // The head class explicitly excludes quotes and `;` so that a side-effect
  // import like `import 'foo'\nimport bar from 'baz'` doesn't get absorbed
  // into a single match spanning two statements.
  const reImport = /(?:^|[;\n\r{])\s*import\s+(?:type\s+)?([^'"`;]*?)\s+from\s+(['"`])([^'"`]+)\2/g
  for (const m of text.matchAll(reImport)) {
    const head = m[1].trim()
    const src = m[3]
    const closeQuoteOffset = (m.index ?? 0) + m[0].length - 1
    const sourceFrom = closeQuoteOffset - src.length
    const entry: ImportEntry = { source: src, sourceFrom, sourceTo: closeQuoteOffset, named: [] }
    parseImportHead(head, entry)
    out.push(entry)
  }

  // Side-effect: import "source"
  const reSE = /(?:^|[;\n\r{])\s*import\s+(['"`])([^'"`]+)\1/g
  for (const m of text.matchAll(reSE)) {
    const src = m[2]
    const closeQuoteOffset = (m.index ?? 0) + m[0].length - 1
    const sourceFrom = closeQuoteOffset - src.length
    out.push({ source: src, sourceFrom, sourceTo: closeQuoteOffset, named: [] })
  }

  // export ... from "source" (re-export — treat like import for resolution)
  const reExp = /(?:^|[;\n\r{])\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+(['"`])([^'"`]+)\1/g
  for (const m of text.matchAll(reExp)) {
    const src = m[2]
    const closeQuoteOffset = (m.index ?? 0) + m[0].length - 1
    const sourceFrom = closeQuoteOffset - src.length
    out.push({ source: src, sourceFrom, sourceTo: closeQuoteOffset, named: [] })
  }

  return out
}

function parseImportHead(head: string, entry: ImportEntry): void {
  if (!head) return
  // Split top-level commas, ignoring those inside { }
  const parts: string[] = []
  let depth = 0
  let buf = ''
  for (const c of head) {
    if (c === '{') depth++
    else if (c === '}') depth--
    if (c === ',' && depth === 0) {
      if (buf.trim()) parts.push(buf.trim())
      buf = ''
    } else {
      buf += c
    }
  }
  if (buf.trim()) parts.push(buf.trim())

  for (const p of parts) {
    if (p.startsWith('{') && p.endsWith('}')) {
      const inner = p.slice(1, -1)
      for (const segment of inner.split(',')) {
        const t = segment.trim().replace(/^type\s+/, '')
        if (!t) continue
        const sp = /^(\w+)\s+as\s+(\w+)$/.exec(t)
        if (sp) {
          entry.named.push({ imported: sp[1], local: sp[2] })
        } else if (/^\w+$/.test(t)) {
          entry.named.push({ imported: t, local: t })
        }
      }
    } else if (p.startsWith('*')) {
      const ns = /^\*\s+as\s+(\w+)$/.exec(p)
      if (ns) entry.namespaceName = ns[1]
    } else if (/^\w+$/.test(p)) {
      entry.defaultName = p
    }
  }
}

function parseImportsVue(text: string): ImportEntry[] {
  const out: ImportEntry[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  for (const m of text.matchAll(re)) {
    const inner = m[1]
    const innerStart = (m.index ?? 0) + m[0].indexOf(inner)
    for (const e of parseImportsTsLike(inner)) {
      out.push({
        ...e,
        sourceFrom: e.sourceFrom + innerStart,
        sourceTo: e.sourceTo + innerStart,
      })
    }
  }
  return out
}

function parseImportsGo(text: string): ImportEntry[] {
  const out: ImportEntry[] = []

  // Block: import ( ... )
  const blockRe = /\bimport\s*\(\s*([\s\S]*?)\)/g
  for (const m of text.matchAll(blockRe)) {
    const inner = m[1]
    const innerStart = (m.index ?? 0) + m[0].indexOf(inner)
    const lineRe = /^[\t ]*(?:(\w+|\.|_)\s+)?"([^"]+)"/gm
    for (const lm of inner.matchAll(lineRe)) {
      const src = lm[2]
      const localQuoteIdx = lm[0].indexOf(`"${src}"`)
      const sourceFrom = innerStart + (lm.index ?? 0) + localQuoteIdx + 1
      out.push({
        source: src,
        sourceFrom,
        sourceTo: sourceFrom + src.length,
        named: [],
      })
    }
  }

  // Single line: import [alias] "..."
  const singleRe = /(?:^|[;\n\r])[\t ]*import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/g
  for (const m of text.matchAll(singleRe)) {
    const src = m[2]
    const localQuoteIdx = m[0].indexOf(`"${src}"`)
    const sourceFrom = (m.index ?? 0) + localQuoteIdx + 1
    out.push({
      source: src,
      sourceFrom,
      sourceTo: sourceFrom + src.length,
      named: [],
    })
  }

  return out
}

/**
 * Memoized version of `parseImports` keyed by the underlying CodeMirror
 * `Text` instance — stable across non-doc-changing transactions, so hover
 * lookups don't re-run regex on every mousemove.
 */
const importsCache = new WeakMap<object, { langId: string; imports: ImportEntry[] }>()

export function parseImportsCached(textKey: object, fullText: string, langId: string): ImportEntry[] {
  const cached = importsCache.get(textKey)
  if (cached && cached.langId === langId) return cached.imports
  const imports = parseImports(fullText, langId)
  importsCache.set(textKey, { langId, imports })
  return imports
}

/**
 * Find the import entry whose source range contains the given offset.
 * Used by the editor extension to detect Ctrl+click on an import path.
 */
export function findImportAt(imports: ImportEntry[], offset: number): ImportEntry | null {
  for (const imp of imports) {
    if (offset >= imp.sourceFrom && offset <= imp.sourceTo) return imp
  }
  return null
}

/** Find an import that declares the given local name (default / named / namespace). */
export function findImportForName(imports: ImportEntry[], name: string): ImportEntry | null {
  for (const imp of imports) {
    if (imp.defaultName === name) return imp
    if (imp.namespaceName === name) return imp
    if (imp.named.some((n) => n.local === name)) return imp
  }
  return null
}

/** Look up the original (exported) name for a given local binding inside an import. */
export function importedNameFor(imp: ImportEntry, localName: string): string | undefined {
  if (imp.defaultName === localName) return 'default'
  if (imp.namespaceName === localName) return localName
  const named = imp.named.find((n) => n.local === localName)
  return named?.imported
}
