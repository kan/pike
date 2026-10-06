<script setup lang="ts">
/**
 * 差分の空白の違いを無視するかを切り替えるボタン（#453）。diff タブ・履歴タブ・コミットタブが
 * 同じものを使う（アイコンと文言を 3 か所に写さない）。
 *
 * **持つのは見た目だけ。** 取り直しは置いた側の仕事で、出どころも失敗の扱いもタブごとに違う。
 *
 * `toolbar` は、置き場がツールバー（`.tool-btn` が並ぶ見出し）のとき。それ以外は差分の上に
 * 重ねるボタン（`.editor-toggle`、`WrapToggle.vue` の隣）の様式になる。どちらも `theme.css`。
 */
import { Space } from 'lucide-vue-next'
import { useI18n } from '../i18n'

defineProps<{ on: boolean; toolbar?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    :class="[toolbar ? 'tool-btn' : 'editor-toggle', { active: on }]"
    :title="on ? t('diff.ignoreSpaceDisable') : t('diff.ignoreSpaceEnable')"
    @click="emit('toggle')"
  >
    <Space :size="14" :stroke-width="2" />
  </button>
</template>
