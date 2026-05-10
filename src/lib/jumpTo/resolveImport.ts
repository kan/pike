/**
 * Resolve an import source string to an absolute file path.
 *
 * Supports:
 *  - Relative paths (`./foo`, `../foo`) with extension/index fallback
 *  - TS path aliases via tsconfig.json `compilerOptions.paths`
 *
 * Bare specifiers (`react`, `vue`, ...) are intentionally NOT resolved; we
 * don't want to walk into node_modules from a lightweight editor.
 */

import type { ShellType } from '../../types/tab'
import { dirname, joinPath, pathSep } from '../paths'
import { fsReadFile, fsResolveFirstExisting } from '../tauri'

const TS_LIKE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue']

interface ResolveOpts {
  importPath: string
  fromFile: string
  projectRoot: string
  shell: ShellType
  langId: string
}

export async function resolveImport(opts: ResolveOpts): Promise<string | null> {
  const { importPath, fromFile, projectRoot, shell, langId } = opts
  if (!importPath) return null

  // Go: package directories — defer to project-wide rg fallback (handled in
  // the caller) since proper resolution requires go.mod parsing.
  if (langId === 'go') return null

  const sep = pathSep(shell)

  if (importPath.startsWith('.')) {
    return resolveRelative(importPath, fromFile, sep, shell)
  }

  // Absolute (rare in JS, but legal)
  if (importPath.startsWith('/') || /^[A-Z]:[/\\]/i.test(importPath)) {
    return resolveByCandidates(importPath, sep, shell)
  }

  // Try alias resolution
  const aliased = await resolveAlias(importPath, fromFile, projectRoot, sep, shell)
  if (aliased) return aliased

  return null
}

async function resolveRelative(
  importPath: string,
  fromFile: string,
  sep: '/' | '\\',
  shell: ShellType,
): Promise<string | null> {
  const baseDir = dirname(fromFile)
  const target = joinPath(baseDir, importPath, sep)
  return resolveByCandidates(target, sep, shell)
}

async function resolveByCandidates(target: string, sep: '/' | '\\', shell: ShellType): Promise<string | null> {
  const candidates: string[] = []
  // As-is (already has extension)
  candidates.push(target)
  // With extension
  for (const ext of TS_LIKE_EXTS) candidates.push(target + ext)
  // Index file
  for (const ext of TS_LIKE_EXTS) candidates.push(`${target + sep}index${ext}`)
  return fsResolveFirstExisting(shell, candidates)
}

// --- TS path alias (tsconfig.json) ---

interface AliasMap {
  baseUrl: string // absolute
  paths: { pattern: string; targets: string[] }[]
}

const aliasCache = new Map<string, Promise<AliasMap | null>>()

/** Clear the in-memory tsconfig cache. Call when project changes. */
export function clearAliasCache(): void {
  aliasCache.clear()
}

async function resolveAlias(
  importPath: string,
  fromFile: string,
  projectRoot: string,
  sep: '/' | '\\',
  shell: ShellType,
): Promise<string | null> {
  const map = await loadAliasMap(fromFile, projectRoot, sep, shell)
  if (!map) return null
  for (const entry of map.paths) {
    const matched = matchPattern(importPath, entry.pattern)
    if (matched === null) continue
    for (const tgt of entry.targets) {
      const replaced = tgt.includes('*') ? tgt.replaceAll('*', matched) : tgt
      const absTarget = joinPath(map.baseUrl, replaced, sep)
      const resolved = await resolveByCandidates(absTarget, sep, shell)
      if (resolved) return resolved
    }
  }
  return null
}

/** Returns the captured `*` text, or '' for an exact match, or null if no match. */
function matchPattern(importPath: string, pattern: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) {
    return importPath === pattern ? '' : null
  }
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  if (!importPath.startsWith(head) || !importPath.endsWith(tail)) return null
  return importPath.slice(head.length, importPath.length - tail.length)
}

async function loadAliasMap(
  fromFile: string,
  projectRoot: string,
  sep: '/' | '\\',
  shell: ShellType,
): Promise<AliasMap | null> {
  // Walk up from fromFile toward projectRoot looking for any of tsconfig.json,
  // jsconfig.json, or vite.config.{ts,js,mjs,cjs}. tsconfig wins ties because
  // it's listed first per directory. Single IPC call covers the whole walk.
  const configPath = await findNearestConfig(fromFile, projectRoot, sep, shell)
  if (!configPath) return null
  const map = await loadCached(configPath, () => readAliasMap(configPath, sep, shell))
  return map && map.paths.length > 0 ? map : null
}

async function loadCached(key: string, factory: () => Promise<AliasMap | null>): Promise<AliasMap | null> {
  const cached = aliasCache.get(key)
  if (cached) return cached
  const promise = factory()
  aliasCache.set(key, promise)
  return promise
}

const ALIAS_CONFIG_FILENAMES = [
  'tsconfig.json',
  'jsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const

async function findNearestConfig(
  fromFile: string,
  projectRoot: string,
  sep: '/' | '\\',
  shell: ShellType,
): Promise<string | null> {
  return findNearestUpward(fromFile, projectRoot, sep, shell, ALIAS_CONFIG_FILENAMES)
}

/**
 * Walk up from `fromFile`'s directory toward `projectRoot` and return the
 * first ancestor that contains any of `filenames`. Listed earlier names win
 * ties at the same directory level. Single IPC call covers the whole walk.
 */
export async function findNearestUpward(
  fromFile: string,
  projectRoot: string,
  sep: '/' | '\\',
  shell: ShellType,
  filenames: readonly string[],
): Promise<string | null> {
  const normalizedRoot = projectRoot.replace(/[/\\]+$/, '')
  const dirs: string[] = []
  let cur = dirname(fromFile)
  // Cap iteration to avoid runaway when fromFile sits outside projectRoot.
  for (let i = 0; i < 32; i++) {
    dirs.push(cur)
    if (cur === normalizedRoot) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
    if (!cur.startsWith(normalizedRoot)) {
      if (dirs[dirs.length - 1] !== normalizedRoot) dirs.push(normalizedRoot)
      break
    }
  }
  const candidates: string[] = []
  for (const d of dirs) {
    for (const fn of filenames) candidates.push(joinPath(d, fn, sep))
  }
  return fsResolveFirstExisting(shell, candidates)
}

async function readAliasMap(configPath: string, sep: '/' | '\\', shell: ShellType): Promise<AliasMap | null> {
  let text: string
  try {
    const result = await fsReadFile(shell, configPath)
    text = result.content
  } catch {
    return null
  }
  const dir = dirname(configPath)
  const isTs = configPath.endsWith('tsconfig.json') || configPath.endsWith('jsconfig.json')
  return isTs ? parseTsconfigAliases(text, dir, sep) : parseViteAliases(text, dir, sep)
}

function parseTsconfigAliases(text: string, tsconfigDir: string, sep: '/' | '\\'): AliasMap | null {
  const json = parseJsonc(text)
  if (!json || typeof json !== 'object') return null
  const compilerOptions = (json as Record<string, unknown>).compilerOptions
  if (!compilerOptions || typeof compilerOptions !== 'object') return null
  const co = compilerOptions as Record<string, unknown>
  const baseUrlRel = typeof co.baseUrl === 'string' ? co.baseUrl : '.'
  const baseUrl = joinPath(tsconfigDir, baseUrlRel, sep)
  const rawPaths = co.paths
  const paths: AliasMap['paths'] = []
  if (rawPaths && typeof rawPaths === 'object') {
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (Array.isArray(targets)) {
        const ts = targets.filter((t): t is string => typeof t === 'string')
        if (ts.length > 0) paths.push({ pattern, targets: ts })
      }
    }
  }
  return { baseUrl, paths }
}

// --- Vite config (resolve.alias) ---

/**
 * Parse a `vite.config.{js,ts,mjs,cjs}` for `resolve.alias` entries. Handles
 * the common shapes that real projects use; we don't run JS, just regex out
 * the alias block.
 *
 * Supported value forms:
 *   '<literal>'                                       (string literal)
 *   path.resolve(__dirname, '<rel>')                  (CJS)
 *   resolve(__dirname, '<rel>')
 *   path.join(__dirname, '<rel>')                     (CJS)
 *   join(__dirname, '<rel>')
 *   fileURLToPath(new URL('<rel>', import.meta.url))  (ESM)
 *
 * Both object form `alias: { '@': ... }` and array form
 * `alias: [{ find: '@', replacement: ... }]` are recognized.
 */
function parseViteAliases(text: string, viteConfigDir: string, sep: '/' | '\\'): AliasMap | null {
  const block = extractAliasBlock(text)
  if (!block) return null

  const entries = block.kind === 'object' ? parseAliasObjectEntries(block.body) : parseAliasArrayEntries(block.body)

  const paths: AliasMap['paths'] = []
  for (const { key, rhs } of entries) {
    const replacement = extractAliasValue(rhs, viteConfigDir, sep)
    if (!replacement) continue
    // Vite alias semantics: a key like `@` matches `@`, `@/foo`, `@/foo/bar`.
    // Translate to tsconfig-paths shape so the existing matcher handles it:
    //   pattern: '@'   targets: ['<resolved>']
    //   pattern: '@/*' targets: ['<resolved>/*']
    paths.push({ pattern: key, targets: [replacement] })
    paths.push({ pattern: `${key}/*`, targets: [`${replacement}/*`] })
  }

  if (paths.length === 0) return null
  return { baseUrl: viteConfigDir, paths }
}

/**
 * Find `alias: { ... }` or `alias: [ ... ]` in a vite config and return the
 * inner body (without the outer brackets). Properly tracks brackets and
 * string literals so nested calls like `path.resolve(...)` don't break the
 * scan.
 */
function extractAliasBlock(text: string): { kind: 'object' | 'array'; body: string } | null {
  // First strip comments to make the scan simpler.
  const stripped = stripCommentsForScan(text)
  // Match `resolve.alias: <{ or [` or just `alias: <{ or [` (covers both
  // `resolve: { alias: ... }` and the rare top-level `alias` key).
  // Take the first match — vite configs only have one alias block in practice.
  const m = /\balias\s*:\s*([{[])/.exec(stripped)
  if (!m) return null
  const open = m[1] as '{' | '['
  const startIdx = m.index + m[0].length
  const body = extractBalanced(stripped, startIdx, open)
  if (body == null) return null
  return { kind: open === '{' ? 'object' : 'array', body }
}

/**
 * Starting at `startIdx` (just after an opening bracket `open`), return the
 * substring up to (but not including) the matching closing bracket. Returns
 * null if unbalanced. Skips contents of string literals and template strings.
 */
function extractBalanced(text: string, startIdx: number, open: '{' | '['): string | null {
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

function parseAliasObjectEntries(body: string): { key: string; rhs: string }[] {
  const out: { key: string; rhs: string }[] = []
  for (const seg of splitTopLevel(body, ',')) {
    const trimmed = seg.trim()
    if (!trimmed) continue
    // 'key': value — the key is a quoted string in alias objects.
    const m = /^(['"`])([^'"`]+)\1\s*:\s*([\s\S]+)$/.exec(trimmed)
    if (m) out.push({ key: m[2], rhs: m[3].trim() })
  }
  return out
}

function parseAliasArrayEntries(body: string): { key: string; rhs: string }[] {
  const out: { key: string; rhs: string }[] = []
  for (const seg of splitTopLevel(body, ',')) {
    const trimmed = seg.trim()
    if (!trimmed.startsWith('{')) continue
    const inner = trimmed.slice(1, trimmed.lastIndexOf('}'))
    const findMatch = /\bfind\s*:\s*(['"`])([^'"`]+)\1/.exec(inner)
    if (!findMatch) continue
    // Capture replacement: take the segment after `replacement:` up to the
    // next top-level comma (so nested calls aren't truncated).
    const replKey = /\breplacement\s*:\s*/.exec(inner)
    if (!replKey) continue
    const after = inner.slice(replKey.index + replKey[0].length)
    const segs = splitTopLevel(after, ',')
    if (!segs.length) continue
    const rhs = segs[0].trim()
    if (rhs) out.push({ key: findMatch[2], rhs })
  }
  return out
}

function extractAliasValue(rhs: string, viteConfigDir: string, sep: '/' | '\\'): string | null {
  const t = rhs
    .trim()
    .replace(/[,;]+$/, '')
    .trim()

  // path.resolve(__dirname, '...') | resolve(__dirname, '...') | same for join
  const callMatch = /(?:path\.)?(?:resolve|join)\s*\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*\)/.exec(t)
  if (callMatch) {
    return joinPath(viteConfigDir, callMatch[2], sep)
  }

  // fileURLToPath(new URL('...', import.meta.url))
  const urlMatch = /fileURLToPath\s*\(\s*new\s+URL\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)\s*\)/.exec(t)
  if (urlMatch) {
    return joinPath(viteConfigDir, urlMatch[2], sep)
  }

  // Plain string literal
  const strMatch = /^(['"`])([^'"`]+)\1$/.exec(t)
  if (strMatch) {
    const lit = strMatch[2]
    if (lit.startsWith('/') || /^[A-Z]:[/\\]/i.test(lit)) return lit
    return joinPath(viteConfigDir, lit, sep)
  }

  return null
}

function splitTopLevel(text: string, delimiter: string): string[] {
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

/** Strip line/block comments for the alias-block scanner. Strings are preserved. */
function stripCommentsForScan(text: string): string {
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
 * Minimal JSONC parser: strips line/block comments and trailing commas, then
 * delegates to JSON.parse. Sufficient for tsconfig.json which commonly uses
 * comments. Returns null on parse failure.
 */
function parseJsonc(text: string): unknown {
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
