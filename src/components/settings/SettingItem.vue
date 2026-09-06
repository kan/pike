<script setup lang="ts">
/**
 * 設定画面の 1 項目（#314）。**項目名と説明文を i18n キーで受け、自分で描く**ので、
 * 絞り込みの対象になる文言と画面に出る文言が同じものになる（別の表を持たない理由は
 * `useSettingsSearch` の doc）。
 *
 * 形は 2 つ。
 * - 既定（row）… 項目名の右に操作、その下に説明文
 * - `block` … 項目名・説明文の下に操作（一覧・カラースキームの並び・入力欄が伸びるもの）
 *
 * `data-testid` のような属性はフォールスルーでルートへ落ちるので、プロップにしない。
 */
import { computed, inject, provide } from 'vue'
import {
  SETTINGS_ADD_KEYS,
  SETTINGS_GROUP,
  SETTINGS_SECTION,
  useSettingsSearch,
} from '../../composables/useSettingsSearch'
import { useI18n } from '../../i18n'
import HighlightText from './HighlightText.vue'

const props = defineProps<{
  labelKey: string
  hintKey?: string
  /**
   * 絞り込みに当てたい追加の i18n キー。**この項目が自分で描く文言のためのもの**で、
   * 子（`SettingToggle`）が描く選択肢のラベルはあちらが `addKeys` で載せる。
   */
  termKeys?: string[]
  block?: boolean
}>()

const { t } = useI18n()
const search = useSettingsSearch()
const section = inject(SETTINGS_SECTION, '')
const group = inject(SETTINGS_GROUP, null)

// **キーは setup で 1 回だけ読む。** どの項目も props はテンプレートのリテラルで、
// 登録の入れ替えが要る場面が無い。
const entry = {
  section,
  group,
  keys: [props.labelKey, ...(props.hintKey ? [props.hintKey] : []), ...(props.termKeys ?? [])],
}
search.addItem(entry)
provide(SETTINGS_ADD_KEYS, (keys: string[]) => search.addKeys(entry, keys))

const visible = computed(() => search.itemVisible(entry))
</script>

<template>
  <div v-show="visible" class="setting-block">
    <template v-if="block">
      <label class="setting-label"><HighlightText :text="t(labelKey)" /></label>
      <p v-if="hintKey" class="setting-hint"><HighlightText :text="t(hintKey)" /></p>
      <slot />
    </template>
    <template v-else>
      <div class="setting-row">
        <label class="setting-label"><HighlightText :text="t(labelKey)" /></label>
        <slot />
      </div>
      <p v-if="hintKey" class="setting-hint"><HighlightText :text="t(hintKey)" /></p>
    </template>
  </div>
</template>

<style scoped>
/* 器と「名前 + 操作」の行。**scoped のままでよい**: 描くのはこのファイルだけで、
   スロットに渡る中身（`.mode-toggle` 等）は呼び出し側の scoped CSS が当てる。
   `.setting-label` / `.setting-hint` が `theme.css` にあるのは、切り出した部品
   （`panels/AllowedHostList.vue`）とも共有するため。 */
.setting-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
