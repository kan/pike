<script setup lang="ts">
/**
 * DB パネル（#632）。接続先の候補（動いている DB のコンテナ・保存した接続・`.env` の候補）を並べ、
 * 押すとつないで DB タブを開く。つなげなければ接続のダイアログが出る（`stores/db.ts` の `open`）。
 *
 * 候補の組み立てはストアの `candidates` 1 つで、ここは並べるだけ。
 */
import { Box, FileText, LoaderCircle, Plus, Save, Trash2 } from 'lucide-vue-next'
import { computed, onMounted } from 'vue'
import { useI18n } from '../../i18n'
import type { DbCandidate } from '../../lib/dbViewer'
import { useDbStore } from '../../stores/db'

const { t } = useI18n()
const db = useDbStore()

const SECTIONS = [
  { kind: 'container', labelKey: 'db.panelContainers', icon: Box },
  { kind: 'saved', labelKey: 'db.panelSaved', icon: Save },
  { kind: 'env', labelKey: 'db.panelEnv', icon: FileText },
] as const

const sections = computed(() =>
  SECTIONS.map((s) => ({ ...s, rows: db.candidates.filter((c) => c.kind === s.kind) })).filter((s) => s.rows.length),
)

function connect(c: DbCandidate) {
  if (!db.connecting) void db.open(c.target)
}

// 開くたびに軽く揃える（コンテナの一覧の取り直しと、まだなら `.env` の読み込み）。
// プロジェクトを切り替えたときの `.env` の読み直しはストアが持つ。
onMounted(() => void db.refresh())
</script>

<template>
  <div class="db-panel" data-testid="db-panel">
    <section v-for="s in sections" :key="s.kind" class="group">
      <div class="group-head">{{ t(s.labelKey) }}</div>
      <div
        v-for="c in s.rows"
        :key="c.key"
        class="db-row"
        :class="{ busy: db.connecting === c.key }"
        :title="`${c.label}\n${c.detail}`"
        @click="connect(c)"
      >
        <LoaderCircle v-if="db.connecting === c.key" class="db-icon spin" :size="14" :stroke-width="2" />
        <component :is="s.icon" v-else class="db-icon" :size="14" :stroke-width="2" />
        <div class="db-text">
          <div class="db-label">{{ c.label }}</div>
          <div class="db-detail">{{ c.detail }}</div>
        </div>
        <!-- 消せるのは保存した接続だけ（コンテナと `.env` は出所が別にある）。 -->
        <button
          v-if="c.kind === 'saved'"
          type="button"
          class="row-action"
          :title="t('db.forget')"
          @click.stop="db.forget(c.key)"
        >
          <Trash2 :size="12" :stroke-width="2" />
        </button>
      </div>
    </section>
    <div v-if="!sections.length" class="empty">{{ t('db.panelEmpty') }}</div>
    <!-- 行の接続を待っているあいだは開かせない（待っていた接続の結果と、新しく入れているダイアログが混ざる）。 -->
    <button
      type="button"
      class="db-new"
      data-testid="db-new-connection"
      :disabled="db.connecting !== null"
      @click="db.openDialog()"
    >
      <Plus :size="13" :stroke-width="2" />
      <span>{{ t('db.newConnection') }}</span>
    </button>
  </div>
</template>

<style scoped>
/* スクロールはサイドバーの `.panel-content` に任せる（自分で持つと二重になる）。 */
.db-panel {
  padding: 4px 0;
}

.group + .group {
  margin-top: 6px;
}

.group-head {
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.db-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 8px 4px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.db-row:hover {
  background: var(--bg-tertiary);
}

.db-row.busy {
  cursor: progress;
}

.db-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--text-secondary);
}

.db-text {
  flex: 1;
  min-width: 0;
}

.db-label,
.db-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-detail {
  font-size: 11px;
  color: var(--text-secondary);
}

/* ボタン本体は共有の `.row-action`（`theme.css`）。ここに残すのは出す契機だけ。 */
.db-row:hover .row-action {
  opacity: 1;
}

.empty {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.db-new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 6px;
  padding: 6px 14px;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.db-new:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.db-new:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
