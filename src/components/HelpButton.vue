<script setup lang="ts">
import { CircleHelp } from 'lucide-vue-next'
import { useI18n } from '../i18n'
import { manualTarget } from '../lib/manual'
import { useTabStore } from '../stores/tabs'

// `page` is a manual-relative target, e.g. `settings.md#外観テーマフォントui-サイズ`.
const props = defineProps<{ page: string; size?: number }>()
const { t } = useI18n()
const tabStore = useTabStore()

function open() {
  tabStore.addManualTab(manualTarget(props.page))
}
</script>

<template>
  <button class="help-btn" :title="t('manual.openHelp')" @click.stop="open">
    <CircleHelp :size="props.size ?? 13" :stroke-width="2" />
  </button>
</template>

<style scoped>
.help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.help-btn:hover {
  color: var(--accent);
  background: var(--tab-hover-bg);
}
</style>
