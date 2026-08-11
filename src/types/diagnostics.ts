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
  /** Tool that produced it: 'rustc' | 'go vet' | 'golangci-lint' | 'tsc'. */
  source: string
  /** Diagnostic code when available ('E0382', 'TS2304', the linter name, ...). */
  code?: string | null
}

export interface ProviderRun {
  /** 'rust' | 'go' | 'golangci' | 'ts' */
  name: string
  /** Root-relative directory the checker ran in. */
  dir: string
  /** The command line that ran. Shown when a checker fails: with a
   *  project-configured override in play, 'checker failed' alone doesn't say
   *  what was actually invoked. */
  command: string
  ok: boolean
  error?: string | null
  count: number
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  providers: ProviderRun[]
  truncated: boolean
  /** The project has a Go module set up for golangci-lint, so the panel can
   *  offer the toggle. Reported whether or not the linter actually ran. */
  golangciAvailable: boolean
}
