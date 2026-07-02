import { claudeUsageRateGet } from '../lib/tauri'
import type { ClaudeRateLimits } from '../types/claudeUsage'
import { useClaudeUsageStore } from './claudeUsage'
import { createUsageStore } from './usageStore'

/**
 * Rate-limit usage (`claude -p "/usage"`). Polling is cheap: Rust serves a
 * cached result and only re-runs the CLI on TTL expiry (short while a Claude
 * session is active, long while idle) or on `refreshUsage(true)`.
 */
export const useClaudeRateStore = createUsageStore<ClaudeRateLimits>('claudeRate', (shell, projectRoot, force) => {
  const sessionActive = useClaudeUsageStore().usage?.active ?? false
  return claudeUsageRateGet(shell, projectRoot, sessionActive, force)
})
