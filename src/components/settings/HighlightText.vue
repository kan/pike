<script setup lang="ts">
/**
 * 絞り込みに一致した部分を `<mark>` で出す（#314）。設定画面の見出し・項目名・説明文が
 * 共有する。
 *
 * **`v-html` を使わないこと。** 一致部分を `<mark>` で挟むだけなら文字列連結でも書けるが、
 * 入力欄の文字がそのまま HTML として評価される経路を 1 つ作ることになる。切り分けは
 * `useSettingsSearch` の `split` が持ち、こちらは並べるだけ。
 */
import { computed } from 'vue'
import { useSettingsSearch } from '../../composables/useSettingsSearch'

const props = defineProps<{ text: string }>()
const search = useSettingsSearch()
const parts = computed(() => search.split(props.text))
</script>

<template>
  <span
    ><template v-for="(part, i) in parts" :key="i"
      ><mark v-if="part.hit" class="search-hit">{{ part.text }}</mark
      ><template v-else>{{ part.text }}</template></template
    ></span
  >
</template>

<style scoped>
.search-hit {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  color: inherit;
  border-radius: 2px;
}
</style>
