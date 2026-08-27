<script setup lang="ts">
/**
 * エディタの折り返しを切り替えるボタン（#241）。
 *
 * **2 つのヘッダで同じものを使うために切り出してある。** プレビュー付きのツールバーと
 * パンくずのヘッダは別々のボタン様式（`.preview-toggle` と `.header-icon-btn`）を持って
 * いて、そのまま両方に書くとラベル・アイコン・トグル条件が 2 コピーになる。しかも 2 つの
 * ヘッダは排他表示なので、片方だけ直しても目視では気付けない。
 */
import { WrapText } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

defineProps<{ on: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    class="wrap-toggle"
    :class="{ active: on }"
    :title="on ? t('editor.wordWrapDisable') : t('editor.wordWrapEnable')"
    @click="emit('toggle')"
  >
    <WrapText :size="14" :stroke-width="2" />
  </button>
</template>

<style scoped>
/* 親のヘッダの様式に合わせず、アイコンボタンとして自前で持つ。どちらのヘッダに置いても
   同じ見た目になり、`.preview-toggle` の padding と詳細度を争う必要も無くなる。 */
.wrap-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.wrap-toggle:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.wrap-toggle.active {
  color: var(--accent);
}
</style>
