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
  filename: string
  langId: string
  state: EditorState
}

/** Returns null if this extractor doesn't apply (caller falls back). */
export type Extractor = (text: string, ctx: ExtractContext) => OutlineNode[] | null
