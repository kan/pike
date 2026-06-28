import { codexUsageGet } from '../lib/tauri'
import type { CodexUsageResult } from '../types/codexUsage'
import { createUsageStore } from './usageStore'

/**
 * Polls `~/.codex` rollout files for Codex CLI sessions running in the current
 * project — i.e. Codex used *indirectly* (a Claude codex skill, a script calling
 * the `codex` CLI), which never goes through Pike's agent runtime. "Active" is
 * mtime-based (Codex has no pidfile), so usage disappears once the session goes
 * idle.
 */
export const useCodexUsageStore = createUsageStore<CodexUsageResult>('codexUsage', codexUsageGet)
