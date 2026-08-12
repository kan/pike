<script setup lang="ts">
/**
 * Agent status tab (#226) — the `/status` equivalent.
 *
 * Claude and Codex sit side by side so the two can be compared at a glance. The
 * numbers come from the same stores the status bar reads; this view is the place
 * for the detail (per-model breakdown, every rate window) that the status-bar
 * dropdown is too small to carry.
 *
 * Rows render even when a value is missing, showing why — a status screen that
 * hides what it couldn't fetch is indistinguishable from one that is broken.
 */
import { Bot, Cpu, RefreshCw } from 'lucide-vue-next'
import { useAgentUsage } from '../../composables/useAgentUsage'
import { useI18n } from '../../i18n'
import { formatCost, formatTokens } from '../../lib/format'
import { relativeTime } from '../../lib/paths'
import { fetchedAtLabel } from '../../lib/usageFormat'
import HelpButton from '../HelpButton.vue'
import RateMeters from '../RateMeters.vue'

const { t } = useI18n()
const {
  claudeUsage,
  claudeRate,
  claudeAccount,
  claudeMeters,
  codexSession,
  codexCliUsage,
  codexAccount,
  codexMeters,
  refreshing,
  refreshAll,
} = useAgentUsage()
</script>

<template>
  <div class="agent-status">
    <header class="head">
      <h1>{{ t('agentStatus.title') }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="refreshing" @click="refreshAll">
          <RefreshCw :size="13" :stroke-width="2" :class="{ 'spin-icon': refreshing }" />
          <span>{{ t('common.refresh') }}</span>
        </button>
        <HelpButton page="terminal-and-agents.md#エージェント状態タブ" :size="15" />
      </div>
    </header>

    <div class="cards">
      <!-- Claude -->
      <section class="card">
        <div class="card-head">
          <Cpu :size="15" :stroke-width="2" />
          <span>Claude Code</span>
        </div>

        <dl class="facts">
          <dt>{{ t('agentStatus.account') }}</dt>
          <dd>{{ claudeAccount?.email ?? claudeAccount?.displayName ?? t('agentStatus.unknown') }}</dd>
          <dt>{{ t('agentStatus.organization') }}</dt>
          <dd>{{ claudeAccount?.organization ?? t('agentStatus.unknown') }}</dd>
          <dt>{{ t('agentStatus.plan') }}</dt>
          <dd>{{ claudeAccount?.plan ?? t('agentStatus.unknown') }}</dd>
          <dt>{{ t('agentStatus.configDir') }}</dt>
          <dd class="mono">{{ claudeUsage?.configDir ?? t('agentStatus.configDirDefault') }}</dd>
          <dt>{{ t('agentStatus.session') }}</dt>
          <dd>{{ claudeUsage?.active ? t('agentStatus.running') : t('agentStatus.noSession') }}</dd>
        </dl>

        <div class="block">
          <div class="block-head">
            <span>{{ t('statusBar.rate') }}</span>
            <span v-if="claudeRate" class="muted">{{ fetchedAtLabel(claudeRate.fetchedAt) }}</span>
          </div>
          <RateMeters :meters="claudeMeters" />
        </div>

        <div class="block">
          <div class="block-head">
            <span>{{ t('agentStatus.tokens') }}</span>
            <span v-if="claudeUsage?.estimatedCostUsd != null" class="muted">
              ~{{ formatCost(claudeUsage.estimatedCostUsd) }}
            </span>
          </div>
          <table v-if="claudeUsage?.models.length" class="grid">
            <thead>
              <tr>
                <th>{{ t('agentStatus.model') }}</th>
                <th class="num">{{ t('statusBar.ccIn') }}</th>
                <th class="num">{{ t('statusBar.ccOut') }}</th>
                <th class="num">{{ t('statusBar.ccCache') }}</th>
                <th class="num">{{ t('agentStatus.cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in claudeUsage.models" :key="m.model">
                <th>{{ m.model }}</th>
                <td class="num">{{ formatTokens(m.inputTokens) }}</td>
                <td class="num">{{ formatTokens(m.outputTokens) }}</td>
                <td class="num">{{ formatTokens(m.cacheReadTokens) }}</td>
                <td class="num">{{ m.costUsd != null ? formatCost(m.costUsd) : '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">{{ t('agentStatus.noTokens') }}</p>
        </div>
      </section>

      <!-- Codex -->
      <section class="card">
        <div class="card-head">
          <Bot :size="15" :stroke-width="2" />
          <span>Codex</span>
          <span class="muted">{{ codexSession ? t('agentStatus.codexChat') : t('agentStatus.codexCli') }}</span>
        </div>

        <dl v-if="codexAccount" class="facts">
          <dt>{{ t('agentStatus.account') }}</dt>
          <dd>{{ codexAccount.email ?? t('agentStatus.unknown') }}</dd>
          <dt>{{ t('agentStatus.plan') }}</dt>
          <dd>{{ codexAccount.plan ?? codexAccount.authMode ?? t('agentStatus.unknown') }}</dd>
        </dl>

        <template v-if="codexSession?.tokenUsage">
          <div class="block">
            <div class="block-head">
              <span>{{ t('agentStatus.tokens') }}</span>
              <span v-if="codexSession.estimatedCostUsd != null" class="muted">
                ~{{ formatCost(codexSession.estimatedCostUsd) }}
              </span>
            </div>
            <table class="grid">
              <thead>
                <tr>
                  <th>{{ t('agentStatus.model') }}</th>
                  <th class="num">{{ t('statusBar.ccIn') }}</th>
                  <th class="num">{{ t('statusBar.ccOut') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{{ codexSession.selectedModel ?? 'codex' }}</th>
                  <td class="num">{{ formatTokens(codexSession.tokenUsage.input) }}</td>
                  <td class="num">{{ formatTokens(codexSession.tokenUsage.output) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else-if="codexCliUsage">
          <dl class="facts">
            <dt>{{ t('agentStatus.sessionCount') }}</dt>
            <dd>{{ codexCliUsage.sessionCount }}</dd>
            <dt>{{ t('agentStatus.lastUsed') }}</dt>
            <dd>
              {{ codexCliUsage.active
                ? t('agentStatus.running')
                : codexCliUsage.lastActivityAt
                  ? relativeTime(codexCliUsage.lastActivityAt * 1000)
                  : t('agentStatus.unknown') }}
            </dd>
          </dl>

          <div class="block">
            <div class="block-head"><span>{{ t('statusBar.rate') }}</span></div>
            <RateMeters :meters="codexMeters" />
          </div>

          <div class="block">
            <div class="block-head">
              <span>{{ t('agentStatus.tokens') }}</span>
              <span v-if="codexCliUsage.estimatedCostUsd != null" class="muted">
                ~{{ formatCost(codexCliUsage.estimatedCostUsd) }}
              </span>
            </div>
            <table class="grid">
              <thead>
                <tr>
                  <th>{{ t('agentStatus.model') }}</th>
                  <th class="num">{{ t('statusBar.ccIn') }}</th>
                  <th class="num">{{ t('statusBar.ccOut') }}</th>
                  <th class="num">{{ t('statusBar.codexCached') }}</th>
                  <th class="num">{{ t('statusBar.codexReasoning') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{{ codexCliUsage.model ?? 'codex' }}</th>
                  <td class="num">{{ formatTokens(codexCliUsage.totalInputTokens) }}</td>
                  <td class="num">{{ formatTokens(codexCliUsage.totalOutputTokens) }}</td>
                  <td class="num">{{ formatTokens(codexCliUsage.totalCachedInputTokens) }}</td>
                  <td class="num">{{ formatTokens(codexCliUsage.totalReasoningTokens) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <p v-else class="empty">{{ t('agentStatus.noCodex') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.agent-status {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px 24px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.head h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-active);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  color: var(--text-active);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 縦積み。横に広い画面でも表が間延びしないよう、読める幅で頭打ちにする。 */
.cards {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 860px;
}

.card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px 14px 14px;
  background: var(--bg-secondary);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-active);
}

/* ラベル幅は固定。`auto` だと dl ごとに列幅が決まるので、Claude と Codex で、
   また同じカード内の 2 つの dl どうしでラベルの右端が揃わない。 */
.facts {
  display: grid;
  grid-template-columns: 8.5em 1fr;
  /* 設定ディレクトリの値だけ等幅・小さめなので、行の高さではなくベースラインで揃える。 */
  align-items: baseline;
  gap: 3px 12px;
  margin: 0 0 12px;
  font-size: 12px;
}

.facts dt {
  color: var(--text-secondary);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

/* アカウントと利用状況で dl を分けているので、続くときは間隔を詰める。 */
.facts + .facts {
  margin-top: -8px;
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.block + .block {
  margin-top: 12px;
}

.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.muted {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-secondary);
}

/* 数値列を固定幅にして、Claude と Codex の表で列の位置を揃える。`auto` だと表ごとに
   中身（モデル名の長さ、桁数）で列幅が決まり、上下に並べたときにずれる。 */
.grid {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}

.grid .num {
  width: 7em;
}

.grid thead th {
  font-weight: 400;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.grid th {
  text-align: left;
  font-weight: 400;
  padding: 2px 8px 2px 0;
  overflow-wrap: anywhere;
}

.grid td {
  padding: 2px 8px 2px 0;
}

.grid td:last-child,
.grid th:last-child {
  padding-right: 0;
}

/* `.grid th` の text-align に負けないよう、同じ詳細度で書く（見出しだけ左に
   残ってセルとずれていた）。 */
.grid .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}


.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.spin-icon {
  animation: spin 1s linear infinite;
}
</style>
