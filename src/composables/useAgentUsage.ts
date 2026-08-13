/**
 * Agent usage as the UI needs it (#226).
 *
 * The status bar's dropdown and the agent status tab show the same numbers at two
 * levels of detail. The derivation — which Codex source wins, what counts as a
 * known account, how a rate window becomes a bar — belongs in one place; when it
 * lived in both components they had already drifted apart on what "has an
 * account" means.
 */
import { computed } from 'vue'
import { t } from '../i18n'
import { type Meter, rateWindowLabel } from '../lib/usageFormat'
import { useAgentStore } from '../stores/agent'
import { useClaudeRateStore } from '../stores/claudeRate'
import { useClaudeUsageStore } from '../stores/claudeUsage'
import { useCodexUsageStore } from '../stores/codexUsage'
import { useTabStore } from '../stores/tabs'
import type { ClaudeRateWindow } from '../types/claudeUsage'

export function useAgentUsage() {
  const claudeUsageStore = useClaudeUsageStore()
  const claudeRateStore = useClaudeRateStore()
  const codexUsageStore = useCodexUsageStore()
  const agentStore = useAgentStore()
  const tabStore = useTabStore()

  const claudeUsage = computed(() => claudeUsageStore.usage)

  /** Rate-limit windows from `claude -p "/usage"` (account-wide, not per-session). */
  const claudeRate = computed(() => {
    const r = claudeRateStore.usage
    return r?.active ? r : null
  })

  /**
   * The 5h session window — the headline number. No fallback to other windows: a
   * weekly quota must not be labeled "5h".
   */
  const claudeRateSession = computed(() => claudeRate.value?.windows.find((w) => w.kind === 'session') ?? null)

  /**
   * Worth showing even with a single account, since CLAUDE_CONFIG_DIR can point a
   * project at another one and the totals would otherwise look inexplicably empty
   * (#225). An account object with neither email nor name identifies nothing.
   */
  const claudeAccount = computed(() => {
    const a = claudeUsage.value?.account
    return a && (a.email || a.displayName) ? a : null
  })

  const toMeter = (w: ClaudeRateWindow): Meter => ({
    label: rateWindowLabel(w),
    percent: w.usedPercent,
    resetsAt: w.resetsAt,
  })

  const claudeMeters = computed<Meter[]>(() => (claudeRate.value?.windows ?? []).map(toMeter))

  /**
   * The two quotas that apply to everything — 5h then the all-model weekly —
   * for the compact surfaces. Built in that fixed order rather than filtered
   * out of `windows`, so the pair reads the same way wherever it appears
   * regardless of what the CLI printed first. Per-model weeklies are left to
   * the status tab's `claudeMeters`.
   */
  const claudeSummaryMeters = computed<Meter[]>(() => {
    const weekly = claudeRate.value?.windows.find((w) => w.kind === 'weekAll') ?? null
    return [claudeRateSession.value, weekly].filter((w) => w !== null).map(toMeter)
  })

  /** A native Codex chat reports its own session usage and takes precedence. */
  const codexSession = computed(() => {
    const tab = tabStore.activeTab
    if (tab?.kind !== 'agent-chat' || tab.agentType !== 'codex') return null
    const s = agentStore.getExistingSession(tab.id)
    return s?.tokenUsage ? s : null
  })

  /**
   * What the CLI left in `~/.codex`. Not gated on `active` — that only means
   * "written to in the last few minutes", while the aggregate covers the last day,
   * which is what "did I use Codex here today" asks.
   */
  const codexCliUsage = computed(() => {
    if (codexSession.value) return null
    const u = codexUsageStore.usage
    return u && u.sessionCount > 0 ? u : null
  })

  const codexAccount = computed(() => codexUsageStore.usage?.account ?? null)

  /** Token totals from whichever Codex source applies. */
  const codexTokens = computed(() => {
    const chat = codexSession.value
    if (chat?.tokenUsage) {
      return { input: chat.tokenUsage.input, output: chat.tokenUsage.output, cost: chat.estimatedCostUsd }
    }
    const cli = codexCliUsage.value
    if (!cli) return null
    return { input: cli.totalInputTokens, output: cli.totalOutputTokens, cost: cli.estimatedCostUsd }
  })

  const codexMeters = computed<Meter[]>(() => {
    const session = codexCliUsage.value?.rateLimitPrimary
    const weekly = codexCliUsage.value?.rateLimitSecondary
    return [
      ...(session ? [{ label: t('statusBar.rate5h'), percent: session.usedPercent }] : []),
      ...(weekly ? [{ label: t('statusBar.rateWeekly'), percent: weekly.usedPercent }] : []),
    ]
  })

  /**
   * What the status bar squeezes into "25% / 5%". One agent's pair, never a mix:
   * the two numbers sit side by side with no room to say whose quota each is, so
   * the agent that reports rate limits at all supplies both slots.
   */
  const headlineMeters = computed<Meter[]>(() =>
    claudeSummaryMeters.value.length ? claudeSummaryMeters.value : codexMeters.value,
  )

  const hasClaude = computed(() => Boolean(claudeAccount.value || claudeRate.value || claudeUsage.value?.active))
  const hasCodex = computed(() => Boolean(codexTokens.value || codexAccount.value?.email))

  const refreshing = computed(
    () => claudeUsageStore.refreshing || claudeRateStore.refreshing || codexUsageStore.refreshing,
  )

  function refreshAll() {
    void claudeUsageStore.refreshUsage(true)
    void claudeRateStore.refreshUsage(true)
    void codexUsageStore.refreshUsage(true)
  }

  return {
    claudeUsage,
    claudeRate,
    claudeRateSession,
    claudeAccount,
    claudeMeters,
    claudeSummaryMeters,
    codexSession,
    codexCliUsage,
    codexAccount,
    codexTokens,
    codexMeters,
    headlineMeters,
    hasClaude,
    hasCodex,
    refreshing,
    refreshAll,
  }
}
