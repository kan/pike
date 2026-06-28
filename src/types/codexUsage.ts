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
}
