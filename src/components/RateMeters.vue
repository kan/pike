<script setup lang="ts">
/**
 * Rate-limit windows as horizontal bars (#226). Claude and Codex report their
 * quotas differently, so both are normalized to `Meter` by the caller and drawn
 * here — otherwise the bar markup and the four `rateLevelClass` bindings would
 * have to be kept in step in two places.
 */
import { useI18n } from '../i18n'
import { localizedResetLabel, type Meter, rateLevelClass } from '../lib/usageFormat'

defineProps<{ meters: Meter[] }>()

const { t } = useI18n()
</script>

<template>
  <!-- 単一ルート。fragment ルートだと呼び出し側の class（余白）が渡らない。 -->
  <div class="meters">
    <div v-for="m in meters" :key="m.label" class="meter">
      <div class="meter-top">
        <span>{{ m.label }}</span>
        <span class="meter-pct" :class="rateLevelClass(m.percent)">{{ m.percent.toFixed(0) }}%</span>
      </div>
      <div class="meter-track">
        <div
          class="meter-fill"
          :class="rateLevelClass(m.percent)"
          :style="{ width: `${Math.min(100, m.percent)}%` }"
        />
      </div>
      <div v-if="m.resetsAt" class="meter-reset">
        {{ t('statusBar.ccRateResets', { when: localizedResetLabel(m.resetsAt) }) }}
      </div>
    </div>
    <!--
      **空のときの文言は持たない**（#263）。呼ぶ側が `meters.length > 0` で出し分ける。
      利用率を構造的に出せないエージェント（opencode は BYOK、Copilot は非対話で読めない）に
      対して「取得できていません」と出すと、恒久的な事実を取得失敗として見せてしまう。
    -->
  </div>
</template>

<style scoped>
.meter + .meter {
  margin-top: 8px;
}

.meter-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.meter-pct {
  font-variant-numeric: tabular-nums;
}

.meter-track {
  height: 6px;
  margin-top: 3px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.2s ease;
}

/* `--warning` はテーマに無い。黄色は git の modified と同じ変数を使う。 */
.meter-pct.rate-warn,
.meter-fill.rate-warn {
  color: var(--git-modify);
  background: var(--git-modify);
}

.meter-pct.rate-warn {
  background: none;
}

.meter-pct.rate-danger,
.meter-fill.rate-danger {
  color: var(--danger);
  background: var(--danger);
}

.meter-pct.rate-danger {
  background: none;
}

.meter-reset {
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-secondary);
}

</style>
