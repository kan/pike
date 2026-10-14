/**
 * Minimal JSONC parser: strips line/block comments and trailing commas, then
 * delegates to JSON.parse. Sufficient for tsconfig.json (definition jump) and
 * `.vscode/settings.json` (worktree creation, #478), which commonly use
 * comments. Returns null on parse failure.
 */
export function parseJsonc(text: string): unknown {
  // Strip comments while respecting strings
  let out = ''
  let i = 0
  let inStr: '"' | "'" | null = null
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
    if (c === '"' || c === "'") {
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
  // Strip trailing commas: ,] or ,}
  out = out.replace(/,(\s*[\]}])/g, '$1')
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}
