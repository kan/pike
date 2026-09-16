import type { EditorState } from '@codemirror/state'

export type OutlineKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enumMember'
  | 'module'
  | 'namespace'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'macro'
  | 'type'
  | 'heading'
  | 'section'
  | 'key'

export interface OutlineNode {
  /** Stable id for v-for keying. Built from kind + name + line. */
  id: string
  name: string
  detail?: string
  kind: OutlineKind
  /** 1-based line number for jump. */
  line: number
  /** CodeMirror doc offsets (selection / highlight). */
  from: number
  to: number
  children: OutlineNode[]
}

export interface ExtractContext {
  /**
   * 種別のキー（`lib/fileType.ts` の `fileTypeKey`）。**ファイル名は渡さない**（#347 / #348）:
   * 複合名（`Dockerfile.dev` / `GNUmakefile`）の解釈は共通の判定が済ませているので、抽出器の
   * 振り分けに名前そのものが要らなくなった。
   */
  langId: string
  state: EditorState
}

/** Returns null if this extractor doesn't apply (caller falls back). */
export type Extractor = (text: string, ctx: ExtractContext) => OutlineNode[] | null
