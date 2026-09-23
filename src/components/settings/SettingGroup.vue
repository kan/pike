<script setup lang="ts">
/**
 * セクションの中の小見出し（#314）。長い節（ターミナル・エディタ）を「表示」「操作」の
 * ように分ける。
 *
 * **id は連番で振る**（`addGroup` が返す）。同じ小見出しを別の節で使うので、i18n キーは
 * 一意にならない。
 */
import { computed, provide } from 'vue'
import { SETTINGS_GROUP, useSettingsSearch } from '../../composables/useSettingsSearch'
import { useI18n } from '../../i18n'
import HighlightText from './HighlightText.vue'

/** `hintKey` は小見出しの直下に出す、その群れ全体の説明（各項目に同じ文を並べない）。 */
const props = defineProps<{ titleKey: string; hintKey?: string }>()

const { t } = useI18n()
const search = useSettingsSearch()
const id = search.addGroup(props.titleKey)
provide(SETTINGS_GROUP, id)

const visible = computed(() => search.groupVisible(id))
</script>

<template>
  <div v-show="visible" class="setting-group">
    <h4 class="group-title"><HighlightText :text="t(titleKey)" /></h4>
    <p v-if="hintKey" class="setting-hint group-hint">{{ t(hintKey) }}</p>
    <slot />
  </div>
</template>

<style scoped>
.setting-group {
  margin-bottom: 8px;
}

.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 12px 0 2px 0;
  opacity: 0.8;
}

.group-hint {
  margin: 0 0 4px 0;
}
</style>
