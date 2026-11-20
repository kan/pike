<script setup lang="ts">
/**
 * ホバーするとターミナルをチラ見できる印（#631）。セッションの一覧（`AgentSessionsPanel.vue` /
 * `AgentSessionsTab.vue`）の行に置く。ポップアップ（`TerminalPeekPopup.vue`）も自分で持つ。
 *
 * **印だけをホバー対象にする**: 行全体だと、押そうとして通っただけでポップアップが出る（プロジェクトの
 * プルダウンと同じ）。押したときは行と同じ動き（クリックは止めない）。
 *
 * プロジェクトのプルダウン（`ProjectSelect.vue`）はこれを使わず、ポップアップを直に置く（浮いた一覧の
 * 中なので `nested` を渡す。アイコンも行の部品に合わせてある）。
 */
import { SquareTerminal } from 'lucide-vue-next'
import { useTemplateRef } from 'vue'
import type { TerminalPeekHandle } from '../composables/useTerminalPeek'
import { useI18n } from '../i18n'
import TerminalPeekPopup from './TerminalPeekPopup.vue'

const props = defineProps<{
  /** 覗くタブの id を返す。取り直すたびに呼ばれる（`TerminalPeekHandle.show`）。 */
  resolve: () => string | null
}>()

const { t } = useI18n()
const peek = useTemplateRef<TerminalPeekHandle>('peek')

function show(event: MouseEvent) {
  void peek.value?.show(props.resolve, event.currentTarget as HTMLElement)
}
</script>

<template>
  <span class="peek-mark" :title="t('project.peek')" @mouseenter="show" @mouseleave="peek?.hide()">
    <SquareTerminal :size="13" :stroke-width="2" />
    <TerminalPeekPopup ref="peek" />
  </span>
</template>

<style scoped>
/* 当たり判定を少し広げる（アイコン 13px のままだと狙いにくい）。 */
.peek-mark {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--text-secondary);
}

.peek-mark:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}
</style>
