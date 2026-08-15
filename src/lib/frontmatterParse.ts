import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import type { FrontmatterBlock, FrontmatterKind } from './frontmatter'

/**
 * Values out of a front matter block, for the Markdown preview.
 *
 * Split from `frontmatter.ts` because the YAML and TOML parsers are ~106 KB the outline
 * extractor has no use for. Failures carry a reason rather than a sentence: the caller
 * is the render layer and owns the wording.
 */
export type FrontmatterEntry = [key: string, value: string]

export type FrontmatterParse =
  | { ok: true; entries: FrontmatterEntry[] }
  | { ok: false; reason: 'not-mapping' }
  | { ok: false; reason: 'invalid'; message: string }

const PARSERS: Record<FrontmatterKind, (src: string) => unknown> = {
  yaml: parseYaml,
  toml: parseToml,
  json: JSON.parse,
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(formatValue).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Flatten nested maps into dotted keys so the table stays two columns. */
function flatten(value: unknown, prefix: string, out: FrontmatterEntry[]): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
    return
  }
  out.push([prefix, formatValue(value)])
}

/**
 * Parse a block into flat key/value pairs for display.
 *
 * Failures are reported rather than swallowed: showing the raw text beats silently
 * dropping content the author meant to be there.
 */
export function parseFrontmatter(block: FrontmatterBlock): FrontmatterParse {
  let parsed: unknown
  try {
    parsed = PARSERS[block.kind](block.raw)
  } catch (e) {
    return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) }
  }
  // An empty block is empty, not broken (`parseYaml('')` returns null).
  if (parsed == null) return { ok: true, entries: [] }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not-mapping' }

  const entries: FrontmatterEntry[] = []
  for (const [key, value] of Object.entries(parsed)) flatten(value, key, entries)
  return { ok: true, entries }
}
