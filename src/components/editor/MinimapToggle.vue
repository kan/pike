<script setup lang="ts">
/**
 * ミニマップの表示を切り替えるボタン（#282）。
 *
 * 隣の `WrapToggle.vue` と同じく、**タブ単位の上書き**を切り替える（設定タブの
 * 「ミニマップ」が既定値で、こちらはその場の都合で外すためのもの）。置き場所も揃えて
 * あり、2 つのヘッダの両方に出す。見た目は `theme.css` の `.editor-toggle` を共有する。
 */
// グローバルの `Map` を隠さないよう別名で受ける（biome の noShadowRestrictedNames）。
import { Map as MapIcon } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

defineProps<{ on: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    class="editor-toggle"
    :class="{ active: on }"
    :title="on ? t('editor.minimapDisable') : t('editor.minimapEnable')"
    @click="emit('toggle')"
  >
    <MapIcon :size="14" :stroke-width="2" />
  </button>
</template>
