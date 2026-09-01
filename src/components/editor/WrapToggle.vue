<script setup lang="ts">
/**
 * エディタの折り返しを切り替えるボタン（#241）。
 *
 * **2 つのヘッダで同じものを使うために切り出してある。** プレビュー付きのツールバーと
 * パンくずのヘッダは別々のボタン様式（`.preview-toggle` と `.header-icon-btn`）を持って
 * いて、そのまま両方に書くとラベル・アイコン・トグル条件が 2 コピーになる。しかも 2 つの
 * ヘッダは排他表示なので、片方だけ直しても目視では気付けない。
 *
 * 見た目は `theme.css` の `.editor-toggle`（隣に並ぶ `MinimapToggle.vue` と共有）。
 */
import { WrapText } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

defineProps<{ on: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    class="editor-toggle"
    :class="{ active: on }"
    :title="on ? t('editor.wordWrapDisable') : t('editor.wordWrapEnable')"
    @click="emit('toggle')"
  >
    <WrapText :size="14" :stroke-width="2" />
  </button>
</template>
