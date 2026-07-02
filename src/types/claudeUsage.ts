export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
}

export interface ClaudeUsageResult {
  active: boolean
  sessionId: string | null
  startedAt: number | null
  models: ModelUsage[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  estimatedCostUsd: number | null
}

/** One rate-limit window from `claude -p "/usage"` (5h session / weekly). */
export interface ClaudeRateWindow {
  /** Label as printed by the CLI: "session", "week (all models)", "week (Fable)", … */
  label: string
  /** Classification done in Rust next to the parser — never string-match `label` here. */
  kind: 'session' | 'weekAll' | 'other'
  usedPercent: number
  /** Reset description as printed by the CLI, e.g. "Jul 2, 2:39pm (Asia/Tokyo)". */
  resetsAt: string | null
}

export interface ClaudeRateLimits {
  /** True when rate-limit data is available (matches the usage-store factory contract). */
  active: boolean
  /** Epoch seconds of the CLI run that produced `windows` (data age, shown in the UI). */
  fetchedAt: number
  windows: ClaudeRateWindow[]
}
