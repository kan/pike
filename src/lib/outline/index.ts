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

/** Skip extraction for excessively large files. */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_LINES = 50_000

/**
 * Returns OutlineNode tree for the given file, or null if the language is
 * not supported. Empty array means "supported but no symbols".
 */
export function extractOutline(text: string, ctx: ExtractContext): OutlineNode[] | null {
  if (text.length > MAX_BYTES) return null
  if (ctx.state.doc.lines > MAX_LINES) return null

  const extractor = pickExtractor(ctx.langId, ctx.filename)
  if (!extractor) return null

  try {
    return extractor(text, ctx)
  } catch {
    return null
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
