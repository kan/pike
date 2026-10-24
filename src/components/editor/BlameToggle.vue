<script setup lang="ts">
/**
 * 行頭の blame（ガター）を出し入れするボタン（#510）。
 *
 * 隣の `WrapToggle.vue` / `MinimapToggle.vue` と同じく**タブ単位**の切り替えで、2 つのヘッダの
 * 両方に出す。見た目は `theme.css` の `.editor-toggle` を共有する。行頭の blame は既定を持たない
 * ので、右クリックとパレットの切り替えと同じ値（`EditorTab.vue` の `blameGutterOn`）を動かす。
 */
import { GitCommitVertical } from 'lucide-vue-next'
import { useI18n } from '../../i18n'

defineProps<{ on: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <button
    class="editor-toggle"
    :class="{ active: on }"
    :title="on ? t('editor.blameGutterHide') : t('editor.blameGutterShow')"
    @click="emit('toggle')"
  >
    <GitCommitVertical :size="14" :stroke-width="2" />
  </button>
</template>
