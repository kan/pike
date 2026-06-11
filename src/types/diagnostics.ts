export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  /** Root-relative when inside the project, otherwise absolute. */
  file: string
  /** 1-based. */
  line: number
  column: number
  endLine?: number | null
  endColumn?: number | null
  severity: DiagnosticSeverity
  message: string
  /** Tool that produced it: 'rustc' | 'go vet' | 'tsc'. */
  source: string
  /** Diagnostic code when available ('E0382', 'TS2304', ...). */
  code?: string | null
}

export interface ProviderRun {
  /** 'rust' | 'go' | 'ts' */
  name: string
  /** Root-relative directory the checker ran in. */
  dir: string
  ok: boolean
  error?: string | null
  count: number
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  providers: ProviderRun[]
  truncated: boolean
}
