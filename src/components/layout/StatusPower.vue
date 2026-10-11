<script setup lang="ts">
import { BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Plug } from 'lucide-vue-next'
import { type Component, computed } from 'vue'
import { usePowerStatus } from '../../composables/usePowerStatus'
import { useI18n } from '../../i18n'
import type { PowerIcon } from '../../lib/statusPower'

/**
 * ステータスバーの電源の表示（設定の `statusBarPower`、#467）。電源につないでいるか、
 * バッテリーなら残量を、アイコンと色で出す。見せ方の規則は `lib/statusPower.ts`、
 * 値の出どころは `composables/usePowerStatus.ts`。
 */
const { t } = useI18n()
const view = usePowerStatus()

const ICONS: Record<PowerIcon, Component> = {
  plug: Plug,
  full: BatteryFull,
  medium: BatteryMedium,
  low: BatteryLow,
  empty: BatteryWarning,
}

const title = computed(() => {
  const v = view.value
  if (!v) return ''
  if (!v.plugged) return t('statusBar.powerBattery', { percent: String(v.percent) })
  return v.showPercent
    ? t('statusBar.powerPluggedPercent', { percent: String(v.percent) })
    : t('statusBar.powerPlugged')
})
</script>

<template>
  <span v-if="view" class="status-power" :class="`tone-${view.tone}`" :title="title">
    <component :is="ICONS[view.icon]" :size="15" :stroke-width="2" />
    <span v-if="view.showPercent">{{ view.percent }}%</span>
  </span>
</template>

<style scoped>
.status-power {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 利用率の警告（`StatusBar.vue` の `.rate-warn` / `.rate-danger`）と同じ色。親の
   `.status-text` が淡くしているぶんを戻して、警告の色がそのままの濃さで出るようにする。 */
.status-power.tone-warn {
  color: var(--git-modify);
  opacity: 1;
}

.status-power.tone-danger {
  color: var(--danger);
  opacity: 1;
}
</style>
