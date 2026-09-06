<script setup lang="ts">
/**
 * 設定画面の 1 セクション（#314）。左のナビの飛び先（`settings-{id}`）でもある。
 *
 * **絞り込みで消すときは `v-show`。** `v-if` にすると中の `SettingItem` ごと外れて登録が
 * 消え、「空だから節が出る → 項目が戻る」の往復になる（理由は `useSettingsSearch` の doc）。
 */
import { computed, provide } from 'vue'
import { SETTINGS_SECTION, useSettingsSearch } from '../../composables/useSettingsSearch'
import { useI18n } from '../../i18n'
import HelpButton from '../HelpButton.vue'
import HighlightText from './HighlightText.vue'

const props = defineProps<{
  id: string
  titleKey: string
  /** マニュアルの該当ページ（`settings.md#…`）。 */
  help: string
}>()

const { t } = useI18n()
const search = useSettingsSearch()
search.addSection(props.id, props.titleKey)
provide(SETTINGS_SECTION, props.id)

const visible = computed(() => search.sectionVisible(props.id))
</script>

<template>
  <section v-show="visible" :id="`settings-${id}`" class="settings-section">
    <h3 class="section-title">
      <HighlightText :text="t(titleKey)" />
      <HelpButton :page="help" :size="15" />
    </h3>
    <slot />
  </section>
</template>

<style scoped>
.settings-section {
  margin-bottom: 28px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
</style>
