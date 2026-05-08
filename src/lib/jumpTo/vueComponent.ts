/**
 * Vue custom-component → import resolution.
 *
 * Looks for a PascalCase import in the SFC's `<script>` / `<script setup>`
 * blocks whose local binding matches the component name (kebab-case is
 * converted to PascalCase).
 *
 * Also handles `components: { Foo }` and `components: { Foo: SomeOther }`
 * registration in non-setup `<script>` so that Options-API style works too.
 */

import type { ShellType } from '../../types/tab'
import { parseImports } from './parseImports'
import { resolveImport } from './resolveImport'

export interface VueComponentResolveOpts {
  componentName: string
  sfcText: string
  fromFile: string
  projectRoot: string
  shell: ShellType
}

export async function resolveVueComponent(opts: VueComponentResolveOpts): Promise<string | null> {
  const { componentName, sfcText, fromFile, projectRoot, shell } = opts
  const target = toPascalCase(componentName)
  const imports = parseImports(sfcText, 'vue')

  // 1. Direct import binding (script setup, or any plain import)
  for (const imp of imports) {
    if (imp.defaultName === target) {
      return resolveImport({ importPath: imp.source, fromFile, projectRoot, shell, langId: 'vue' })
    }
    if (imp.namespaceName === target) {
      return resolveImport({ importPath: imp.source, fromFile, projectRoot, shell, langId: 'vue' })
    }
    if (imp.named.some((n) => n.local === target)) {
      return resolveImport({ importPath: imp.source, fromFile, projectRoot, shell, langId: 'vue' })
    }
  }

  // 2. Options-API: `components: { Foo, Bar: Imported }`
  const aliasedTo = findOptionsApiAlias(sfcText, target)
  if (aliasedTo) {
    for (const imp of imports) {
      if (imp.defaultName === aliasedTo || imp.named.some((n) => n.local === aliasedTo)) {
        return resolveImport({ importPath: imp.source, fromFile, projectRoot, shell, langId: 'vue' })
      }
    }
  }

  return null
}

function toPascalCase(name: string): string {
  return name.replace(/(?:^|-)([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * In a non-setup `<script>` look for `components: { Foo }` or
 * `components: { Foo: Other }` and return the right-hand-side name.
 * Returns the same name if shorthand.
 */
function findOptionsApiAlias(sfcText: string, componentName: string): string | null {
  // Find a non-setup script block (heuristic: any <script> block).
  // The same technique works whether or not `setup` is present; if the
  // pattern doesn't appear we fall through.
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  for (const scriptMatch of sfcText.matchAll(scriptRe)) {
    const body = scriptMatch[1]
    // components: { ... }
    const compRe = /\bcomponents\s*:\s*\{([\s\S]*?)\}/g
    for (const compMatch of body.matchAll(compRe)) {
      const inner = compMatch[1]
      // Try `Foo,` shorthand or `Foo: Other,`
      const re = new RegExp(`\\b${escapeRegex(componentName)}\\s*(?::\\s*(\\w+))?\\s*[,}\\n]`)
      const m = re.exec(inner)
      if (m) {
        return m[1] ?? componentName
      }
    }
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the Vue tag name at a given offset in the SFC. Looks at the open tag
 * `<TagName ...` or self-closing `<TagName ... />`. Returns null if not in
 * a tag name region.
 */
export function tagNameAt(text: string, offset: number): { name: string; from: number; to: number } | null {
  // Walk left to find an unclosed `<` and confirm a tag-name follows
  let i = offset
  // Allow being on the tag name itself
  while (i > 0) {
    const ch = text[i - 1]
    if (/[A-Za-z0-9-_]/.test(ch)) {
      i--
      continue
    }
    break
  }
  // i now sits at start of the candidate identifier
  if (text[i - 1] !== '<') return null
  // Validate first character is a letter (tag names start with [a-zA-Z])
  if (!/[A-Za-z]/.test(text[i])) return null
  let end = i
  while (end < text.length && /[A-Za-z0-9-_]/.test(text[end])) end++
  const name = text.slice(i, end)
  // Cursor must be within [i, end) for a real "on the tag name" hit
  if (offset < i || offset > end) return null
  return { name, from: i, to: end }
}

/**
 * Decide whether a component name should be treated as a custom component
 * (i.e. user-defined, not a built-in HTML element). Heuristic: PascalCase
 * (uppercase-leading) names are custom; kebab-case with a hyphen are also
 * custom; everything else is treated as built-in.
 */
export function looksLikeCustomComponent(name: string): boolean {
  if (!name) return false
  if (/^[A-Z]/.test(name)) return true
  if (name.includes('-')) return true
  return false
}
