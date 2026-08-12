export interface CodexRateLimitWindow {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export interface CodexUsageResult {
  active: boolean
  sessionId: string | null
  model: string | null
  sessionCount: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  estimatedCostUsd: number | null
  rateLimitPrimary: CodexRateLimitWindow | null
  rateLimitSecondary: CodexRateLimitWindow | null
  /**
   * Newest rollout write (epoch seconds). `active` only covers the last few
   * minutes, so this is what tells the status view when Codex was last used.
   */
  lastActivityAt: number | null
  account: CodexAccount | null
}

/** Whoever is logged in to `~/.codex` (#226). */
export interface CodexAccount {
  email: string | null
  /** ChatGPT plan (`plus`, …). Absent when running on an API key. */
  plan: string | null
  /** Auth method Codex recorded for itself (`chatgpt`, `apikey`, …). */
  authMode: string | null
}
