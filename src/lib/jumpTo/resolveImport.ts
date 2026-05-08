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
  const aliased = await resolveAlias(importPath, projectRoot, sep, shell)
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
  projectRoot: string,
  sep: '/' | '\\',
  shell: ShellType,
): Promise<string | null> {
  const map = await loadAliasMap(projectRoot, sep, shell)
  if (!map) return null
  for (const entry of map.paths) {
    const matched = matchPattern(importPath, entry.pattern)
    if (matched === null) continue
    for (const tgt of entry.targets) {
      const replaced = tgt.includes('*') ? tgt.replace('*', matched) : tgt
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

async function loadAliasMap(projectRoot: string, sep: '/' | '\\', shell: ShellType): Promise<AliasMap | null> {
  const cached = aliasCache.get(projectRoot)
  if (cached) return cached
  const promise = readAliasMap(projectRoot, sep, shell)
  aliasCache.set(projectRoot, promise)
  return promise
}

async function readAliasMap(projectRoot: string, sep: '/' | '\\', shell: ShellType): Promise<AliasMap | null> {
  const candidates = ['tsconfig.json', 'jsconfig.json'].map((n) => joinPath(projectRoot, n, sep))
  const found = await fsResolveFirstExisting(shell, candidates)
  if (!found) return null
  let text: string
  try {
    const result = await fsReadFile(shell, found)
    text = result.content
  } catch {
    return null
  }
  return parseTsconfigAliases(text, projectRoot, sep)
}

function parseTsconfigAliases(text: string, projectRoot: string, sep: '/' | '\\'): AliasMap | null {
  const json = parseJsonc(text)
  if (!json || typeof json !== 'object') return null
  const compilerOptions = (json as Record<string, unknown>).compilerOptions
  if (!compilerOptions || typeof compilerOptions !== 'object') return null
  const co = compilerOptions as Record<string, unknown>
  const baseUrlRel = typeof co.baseUrl === 'string' ? co.baseUrl : '.'
  const baseUrl = joinPath(projectRoot, baseUrlRel, sep)
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
