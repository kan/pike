import { cssExtractor } from './extractors/css'
import { goExtractor } from './extractors/go'
import { htmlExtractor } from './extractors/html'
import { jsonExtractor } from './extractors/json'
import { markdownExtractor } from './extractors/markdown'
import { perlExtractor } from './extractors/perl'
import { pythonExtractor } from './extractors/python'
import { rustExtractor } from './extractors/rust'
import { typescriptExtractor } from './extractors/typescript'
import { vueExtractor } from './extractors/vue'
import { yamlExtractor } from './extractors/yaml'
import type { ExtractContext, Extractor, OutlineNode } from './types'

export type { ExtractContext, OutlineKind, OutlineNode } from './types'

export type OutlineResult = { kind: 'ok'; nodes: OutlineNode[] } | { kind: 'too-large' } | { kind: 'unsupported' }

/** Skip extraction for excessively large files. */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_LINES = 50_000

export function extractOutline(text: string, ctx: ExtractContext): OutlineResult {
  if (text.length > MAX_BYTES || ctx.state.doc.lines > MAX_LINES) {
    return { kind: 'too-large' }
  }

  const extractor = pickExtractor(ctx.langId, ctx.filename)
  if (!extractor) return { kind: 'unsupported' }

  try {
    const nodes = extractor(text, ctx)
    if (!nodes) return { kind: 'unsupported' }
    return { kind: 'ok', nodes }
  } catch {
    return { kind: 'unsupported' }
  }
}

function pickExtractor(langId: string, _filename: string): Extractor | null {
  if (langId === 'md' || langId === 'markdown') return markdownExtractor
  if (langId === 'ts' || langId === 'tsx' || langId === 'js' || langId === 'jsx' || langId === 'mjs') {
    return typescriptExtractor
  }
  if (langId === 'vue') return vueExtractor
  if (langId === 'html' || langId === 'htm') return htmlExtractor
  if (langId === 'css' || langId === 'scss') return cssExtractor
  if (langId === 'rs') return rustExtractor
  if (langId === 'py') return pythonExtractor
  if (langId === 'go') return goExtractor
  if (langId === 'pl' || langId === 'pm') return perlExtractor
  if (langId === 'yaml' || langId === 'yml') return yamlExtractor
  if (langId === 'json' || langId === 'jsonc') return jsonExtractor
  return null
}
