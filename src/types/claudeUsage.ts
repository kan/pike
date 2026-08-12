export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
}

/** Whoever is logged in to the `.claude` directory Pike is reading (#225). */
export interface ClaudeAccount {
  email: string | null
  displayName: string | null
  organization: string | null
  /** Plan as reported by Claude Code, e.g. "max_20x". */
  seatTier: string | null
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
  /** Filled even when no session is active — the status bar shows rate limits regardless. */
  account: ClaudeAccount | null
  /** Set only when `CLAUDE_CONFIG_DIR` moves the directory off its default. */
  configDir: string | null
}

/**
 * One entry of the terminal launcher's resume list (#220) — a past interactive
 * Claude Code session of this project, read out of `~/.claude/projects/…`.
 */
export interface ClaudeSession {
  /** Session id; the argument of `claude --resume`. */
  id: string
  /** Claude's generated title, falling back to the session's last prompt. */
  title: string
  /** Transcript mtime (epoch ms). */
  modifiedAt: number
  gitBranch: string | null
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
