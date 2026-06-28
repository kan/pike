import { claudeUsageGet } from '../lib/tauri'
import type { ClaudeUsageResult } from '../types/claudeUsage'
import { createUsageStore } from './usageStore'

export const useClaudeUsageStore = createUsageStore<ClaudeUsageResult>('claudeUsage', claudeUsageGet)
