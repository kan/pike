<script setup lang="ts">
/**
 * Agent status tab (#226 / #263) — the `/status` equivalent.
 *
 * 使っているエージェントが横に並ぶので、まとめて見比べられる。数字は StatusBar が読むのと
 * 同じストアで、こちらは**ドロップダウンに載らない詳細**（モデル別の内訳、全部の利用率の枠）
 * を出す場所。
 *
 * **種別の分岐を持たない（#263）。** カードは 1 つのマークアップを回すだけで、何が出るかは
 * アダプタが返したもので決まる。4 つで取れるものが揃わない（Copilot にトークンは無く、
 * opencode に利用率は無い）ので、**無い節は出さない**のが基本。
 */
import { Bot, RefreshCw } from 'lucide-vue-next'
import { computed } from 'vue'
import { useAgentUsage } from '../../composables/useAgentUsage'
import { useI18n } from '../../i18n'
import { formatCost, formatTokens } from '../../lib/format'
import { relativeTime } from '../../lib/paths'
import { agentFactLabel, fetchedAtLabel, toMeter } from '../../lib/usageFormat'
import type { TokenRow, UsageFact } from '../../types/agentUsage'
import HelpButton from '../HelpButton.vue'
import RateMeters from '../RateMeters.vue'

const { t } = useI18n()
const { visible, refreshing, refreshAll } = useAgentUsage()

/**
 * 種別固有の値の表示。**`last-activity` だけ整形する**（epoch 秒を相対時刻に）ので、
 * 生の文字列をそのまま出す他のキーと分けてある。
 */
function factValue(f: UsageFact): string {
  if (f.key !== 'last-activity') return f.value
  const secs = Number(f.value)
  return Number.isFinite(secs) ? relativeTime(secs * 1000) : f.value
}

/** その行に数字が 1 つでもあるか（全部 0 の行は表に出さない）。 */
function hasTokens(row: TokenRow | null): boolean {
  return Boolean(row && row.input + row.output + row.cacheRead + row.cacheWrite + row.reasoning > 0)
}

/** 内訳があればそれ、無ければ合計の 1 行。 */
function tokenRows(usage: { rows: TokenRow[]; total: TokenRow | null }): TokenRow[] {
  if (usage.rows.length > 0) return usage.rows
  return hasTokens(usage.total) && usage.total ? [usage.total] : []
}

/** 表に出す列。**どれかの行が持っている列だけ**出す（Codex は cache write を持たない等）。 */
function columns(rows: TokenRow[]) {
  return [
    { key: 'input' as const, label: t('statusBar.ccIn'), show: true },
    { key: 'output' as const, label: t('statusBar.ccOut'), show: true },
    { key: 'cacheRead' as const, label: t('statusBar.ccCache'), show: rows.some((r) => r.cacheRead > 0) },
    { key: 'cacheWrite' as const, label: t('agentStatus.cacheWrite'), show: rows.some((r) => r.cacheWrite > 0) },
    { key: 'reasoning' as const, label: t('statusBar.codexReasoning'), show: rows.some((r) => r.reasoning > 0) },
  ].filter((c) => c.show)
}

/**
 * 描くぶんを 1 枚につき 1 回だけ組む。**テンプレートで `columns(tokenRows(usage))` を
 * 呼ばないこと**: thead と行ごとに再評価され、行数ぶんの `.some()` と `t()` が毎回走るうえ、
 * `tokenRows` は合計しか無いとき新しい配列を作るので `:key` の参照も毎回変わる。
 */
const cards = computed(() =>
  visible.value.map(({ agent, usage }) => {
    const rows = usage ? tokenRows(usage) : []
    return { agent, usage, rows, cols: columns(rows), meters: (usage?.meters ?? []).map(toMeter) }
  }),
)
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
      <section v-for="{ agent, usage, rows, cols, meters } in cards" :key="agent.id" class="card">
        <div class="card-head">
          <Bot :size="15" :stroke-width="2" />
          <span>{{ agent.label }}</span>
        </div>

        <dl v-if="usage" class="facts">
          <template v-if="usage.account?.email || usage.account?.name">
            <dt>{{ t('agentStatus.account') }}</dt>
            <dd>{{ usage.account.email ?? usage.account.name }}</dd>
          </template>
          <template v-if="usage.account?.organization">
            <dt>{{ t('agentStatus.organization') }}</dt>
            <dd>{{ usage.account.organization }}</dd>
          </template>
          <template v-if="usage.account?.plan">
            <dt>{{ t('agentStatus.plan') }}</dt>
            <dd>{{ usage.account.plan }}</dd>
          </template>
          <template v-for="f in usage.facts" :key="f.key">
            <dt>{{ agentFactLabel(f.key) }}</dt>
            <dd :class="{ mono: f.key === 'config-dir' }">{{ factValue(f) }}</dd>
          </template>
          <dt>{{ t('agentStatus.session') }}</dt>
          <dd>{{ usage.active ? t('agentStatus.running') : t('agentStatus.noSession') }}</dd>
        </dl>

        <!-- 利用率を出せないエージェント（opencode は BYOK、Copilot は非対話で読めない）では節ごと出さない。 -->
        <div v-if="meters.length > 0" class="block">
          <div class="block-head">
            <span>{{ t('statusBar.rate') }}</span>
            <span v-if="usage?.fetchedAt" class="muted">{{ fetchedAtLabel(usage.fetchedAt) }}</span>
          </div>
          <RateMeters :meters="meters" />
        </div>

        <div v-if="rows.length > 0" class="block">
          <div class="block-head">
            <span>{{ t('agentStatus.tokens') }}</span>
            <span v-if="usage?.total?.costUsd != null" class="muted">~{{ formatCost(usage.total.costUsd) }}</span>
          </div>
          <table class="grid">
            <thead>
              <tr>
                <th>{{ t('agentStatus.model') }}</th>
                <th v-for="c in cols" :key="c.key" class="num">{{ c.label }}</th>
                <th class="num">{{ t('agentStatus.cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in rows" :key="row.label ?? i">
                <th>{{ row.label ?? agent.label }}</th>
                <td v-for="c in cols" :key="c.key" class="num">
                  {{ formatTokens(row[c.key]) }}
                </td>
                <td class="num">{{ row.costUsd != null ? formatCost(row.costUsd) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p v-if="cards.length === 0" class="empty">{{ t('agentStatus.noAgents') }}</p>
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
