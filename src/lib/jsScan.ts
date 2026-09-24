/**
 * JS / TS の設定ファイル（`vite.config.*` など）を評価せずに読むための、文字列リテラルを
 * 認識する走査。定義ジャンプの alias 解決（`jumpTo/resolveImport.ts`、#398）と Vue SFC の
 * プレビューの開発サーバー探し（`devServer.ts`、#397）が共有する。依存を持たない。
 */

/** Strip line/block comments for the alias-block scanner. Strings are preserved. */
export function stripCommentsForScan(text: string): string {
  let out = ''
  let i = 0
  let inStr: '"' | "'" | '`' | null = null
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Split `text` on `delimiter` where it appears outside brackets and string
 * literals (the entries of an object or array body). A trailing empty segment
 * is dropped.
 */
export function splitTopLevel(text: string, delimiter: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  let buf = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inStr) {
      buf += ch
      if (ch === '\\' && i + 1 < text.length) {
        buf += text[i + 1]
        i += 2
        continue
      }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      buf += ch
      i++
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    if (ch === delimiter && depth === 0) {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  if (buf.trim()) out.push(buf)
  return out
}

/**
 * Starting at `startIdx` (just after an opening bracket `open`), return the
 * substring up to (but not including) the matching closing bracket. Returns
 * null if unbalanced. Skips contents of string literals and template strings.
 */
export function extractBalanced(text: string, startIdx: number, open: '{' | '['): string | null {
  const close = open === '{' ? '}' : ']'
  let depth = 1
  let i = startIdx
  let inStr: '"' | "'" | '`' | null = null
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\' && i + 1 < text.length) {
        i += 2
        continue
      }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      i++
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    if (depth === 0) {
      if (ch !== close) return null
      return text.slice(startIdx, i)
    }
    i++
  }
  return null
}
