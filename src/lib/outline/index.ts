import type { FileTypeKey } from '../fileType'
import { cssExtractor } from './extractors/css'
import { dockerfileExtractor } from './extractors/dockerfile'
import { goExtractor } from './extractors/go'
import { htmlExtractor } from './extractors/html'
import { jsonExtractor } from './extractors/json'
import { kotlinExtractor } from './extractors/kotlin'
import { makefileExtractor } from './extractors/makefile'
import { markdownExtractor } from './extractors/markdown'
import { perlExtractor } from './extractors/perl'
import { phpExtractor } from './extractors/php'
import { pythonExtractor } from './extractors/python'
import { rubyExtractor } from './extractors/ruby'
import { rustExtractor } from './extractors/rust'
import { swiftExtractor } from './extractors/swift'
import { tomlExtractor } from './extractors/toml'
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

  const extractor = extractorFor(ctx.langId)
  if (!extractor) return { kind: 'unsupported' }

  try {
    const nodes = extractor(text, ctx)
    if (!nodes) return { kind: 'unsupported' }
    return { kind: 'ok', nodes }
  } catch {
    return { kind: 'unsupported' }
  }
}

/**
 * 種別のキー → 抽出器（#347 / #348）。
 *
 * **キーは `lib/fileType.ts` の `fileTypeKey` が決める**（`ctx.langId` に入っている）。
 * 以前はここが `extension(path)` を受けて `||` で並べ、`Dockerfile.dev` / `GNUmakefile` の
 * ためだけに正規表現を 2 つ持っていた。複合名の扱いが共通の判定へ移ったので、この表は
 * 「どのキーに抽出器があるか」だけを言う。
 *
 * **表にあるキーは `FILE_TYPE_LABELS` にもあること**（無いキーは `fileTypeKey` が返さないので、
 * 書いても死ぬ）。`satisfies` で縛ってあるのでコンパイルエラーになる。
 */
const EXTRACTORS: Partial<Record<FileTypeKey, Extractor>> = {
  md: markdownExtractor,
  markdown: markdownExtractor,
  ts: typescriptExtractor,
  tsx: typescriptExtractor,
  mts: typescriptExtractor,
  cts: typescriptExtractor,
  js: typescriptExtractor,
  jsx: typescriptExtractor,
  mjs: typescriptExtractor,
  cjs: typescriptExtractor,
  vue: vueExtractor,
  html: htmlExtractor,
  htm: htmlExtractor,
  css: cssExtractor,
  scss: cssExtractor,
  rs: rustExtractor,
  py: pythonExtractor,
  go: goExtractor,
  pl: perlExtractor,
  pm: perlExtractor,
  yaml: yamlExtractor,
  yml: yamlExtractor,
  json: jsonExtractor,
  jsonc: jsonExtractor,
  rb: rubyExtractor,
  kt: kotlinExtractor,
  kts: kotlinExtractor,
  swift: swiftExtractor,
  php: phpExtractor,
  phtml: phpExtractor,
  toml: tomlExtractor,
  dockerfile: dockerfileExtractor,
  makefile: makefileExtractor,
  mk: makefileExtractor,
  mak: makefileExtractor,
} satisfies Partial<Record<FileTypeKey, Extractor>>

/** 表を `string` で引くための見方（キーの検査は上の `satisfies` が済ませている）。 */
function extractorFor(key: string): Extractor | undefined {
  return (EXTRACTORS as Record<string, Extractor | undefined>)[key]
}
