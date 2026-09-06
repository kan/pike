<script setup lang="ts" generic="T extends string | boolean">
/**
 * 設定画面の「並んだボタンから 1 つ選ぶ」（#314）。ON/OFF から 3 択まで、この画面の
 * 選択はすべてこの形なので 1 つに畳んである（畳む前は同じ markup が 14 箇所に写されていた）。
 *
 * **選択肢のラベルは自分で検索語に載せる**（`SETTINGS_ADD_KEYS`）。呼び出し側に
 * `term-keys` として書き写す形にすると、選択肢を 1 つ足したときに片方だけ直って
 * **その語で検索しても出ない**という形で静かにずれる（`useSettingsSearch` の doc）。
 *
 * 一致部分の強調も入るので、「アクリル」で引いたときに、なぜその項目が出たのかが
 * ラベルの側に出る。
 */
import type { Component } from 'vue'
import { inject } from 'vue'
import { SETTINGS_ADD_KEYS } from '../../composables/useSettingsSearch'
import { useI18n } from '../../i18n'
import HighlightText from './HighlightText.vue'

// 型引数は設定の値そのもの（ON/OFF の真偽値と、3 択の文字列 union）。**generic にして
// あるので、選択肢に無い値を書くとその場でコンパイルエラーになる。**
const props = defineProps<{
  modelValue: T
  /** 並べる選択肢。`icon` を持つものはラベルの左にアイコンを出し、tooltip も付ける。 */
  options: { value: T; labelKey: string; icon?: Component }[]
}>()
const emit = defineEmits<{ 'update:modelValue': [T] }>()

const { t } = useI18n()
inject(SETTINGS_ADD_KEYS, null)?.(props.options.map((o) => o.labelKey))
</script>

<template>
  <div class="mode-toggle">
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      class="mode-btn"
      :class="{ active: modelValue === opt.value }"
      :title="opt.icon ? t(opt.labelKey) : undefined"
      @click="emit('update:modelValue', opt.value)"
    >
      <component :is="opt.icon" v-if="opt.icon" :size="16" :stroke-width="1.5" />
      <span><HighlightText :text="t(opt.labelKey)" /></span>
    </button>
  </div>
</template>

<style scoped>
/* `.mode-toggle` / `.mode-btn` は `theme.css` の共有クラス（ショートカット一覧と共有）。
   ここで描くので、呼び出し側の scoped CSS では当てられない。 */
</style>
